const sdk = require("@defillama/sdk");
const { nullAddress } = require("../helper/tokenMapping");

const TVL_REPORTER = "0x0A4420823e2c415C9D5ABC668b0915b62f7409Fb"; // same address on every chain
const KYC_FACTORY = "";
const USDC_USD_FEED = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6"; // Chainlink USDC/USD
const NAV_DECIMALS = 18n;

const abi = {
  getContainers: "function getContainers() view returns (address[] containers, uint256[] weights)",
  containerType: "uint8:containerType",
  remoteChainId: "uint256:remoteChainId",
  isReshuffling: "bool:isReshuffling",
  getStrategiesNav: "uint256:getStrategiesNav",
  getPreReshufflingSnapshot: "uint256:getPreReshufflingSnapshot",
  notion: "address:notion",
  tvl: "uint256:tvl",
  latestRoundData:
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
};

const ContainerType = {
  LOCAL: 0,
  PRINCIPAL: 1,
  AGENT: 2,
};

const vaults = {
  ethereum: ["0x1d71c888961c4600cF0E31F6196b4dA7fE72e4B3"],
};

const chainIdToName = {};
Object.entries(sdk.providerListJSON ?? {}).forEach(([name, { chainId }]) => {
  if (chainId) chainIdToName[chainId] = name;
});

function getChainName(chainId) {
  const name = chainIdToName[Number(chainId)];
  if (!name) throw new Error(`Unknown chainId ${chainId}`);
  return name;
}

function getApiForChain(api, chainId) {
  if (Number(chainId) === Number(api.chainId)) return api;
  return new sdk.ChainApi({ chain: getChainName(chainId), timestamp: api.timestamp });
}

function scaleNavToToken(nav, tokenDecimals) {
  const tokenDec = BigInt(tokenDecimals);
  if (tokenDec === NAV_DECIMALS) return nav;
  if (tokenDec < NAV_DECIMALS) return nav / (10n ** (NAV_DECIMALS - tokenDec));
  return nav * (10n ** (tokenDec - NAV_DECIMALS));
}

function usd18ToToken(usd18, price, oracleDecimals, tokenDecimals) {
  const priceBn = BigInt(price);
  if (priceBn <= 0n) throw new Error("Invalid USDC/USD price");
  return (
    (usd18 * 10n ** BigInt(tokenDecimals) * 10n ** BigInt(oracleDecimals)) /
    (priceBn * 10n ** NAV_DECIMALS)
  );
}

async function getVaultTvl(api, vault) {
  const [containersRes, isReshuffling] = await Promise.all([
    api.call({ target: vault, abi: abi.getContainers }),
    api.call({ target: vault, abi: abi.isReshuffling }),
  ]);
  const containers = (containersRes.containers ?? containersRes[0] ?? []).filter(
    (c) => c && c !== nullAddress
  );
  if (!containers.length) return 0n;

  const types = await api.multiCall({ abi: abi.containerType, calls: containers });
  const chainIds = new Set();
  const principals = [];

  for (let i = 0; i < containers.length; i++) {
    if (Number(types[i]) === ContainerType.PRINCIPAL) principals.push(containers[i]);
    else chainIds.add(Number(api.chainId));
  }

  if (principals.length) {
    const remotes = await api.multiCall({ abi: abi.remoteChainId, calls: principals });
    remotes.forEach((id) => chainIds.add(Number(id)));
  }

  const navAbi = isReshuffling ? abi.getPreReshufflingSnapshot : abi.getStrategiesNav;
  const navs = await Promise.all(
    [...chainIds].map((id) => getApiForChain(api, id).call({ target: TVL_REPORTER, abi: navAbi }))
  );
  return navs.reduce((acc, v) => acc + BigInt(v), 0n);
}

async function addVaultTvl(api, vault) {
  const [nav, notion] = await Promise.all([
    getVaultTvl(api, vault),
    api.call({ target: vault, abi: abi.notion }),
  ]);
  const decimals = await api.call({ target: notion, abi: "erc20:decimals" });
  api.add(notion, scaleNavToToken(nav, decimals));
  return { notion, decimals };
}

async function addKycFactoryTvl(api, notion, decimals) {
  if (!KYC_FACTORY) return;
  const [kycTvl, round, oracleDecimals] = await Promise.all([
    api.call({ target: KYC_FACTORY, abi: abi.tvl }),
    api.call({ target: USDC_USD_FEED, abi: abi.latestRoundData }),
    api.call({ target: USDC_USD_FEED, abi: "uint8:decimals" }),
  ]);
  const price = BigInt(round.answer ?? round[1]);
  api.add(notion, usd18ToToken(BigInt(kycTvl), price, oracleDecimals, decimals));
}

async function tvl(api) {
  const chainVaults = vaults[api.chain] || [];
  const results = await Promise.all(chainVaults.map((vault) => addVaultTvl(api, vault)));
  if (results[0]) await addKycFactoryTvl(api, results[0].notion, results[0].decimals);
}

module.exports = {
  methodology:
    "Shift DeFi's total protocol TVL is calculated as the sum of the TVLs of all Vaults within the ecosystem. Each Vault's TVL is calculated as the sum of the NAVs of all strategies that make up the Vault's portfolio.",
};

Object.keys(vaults).forEach((chain) => {
  module.exports[chain] = { tvl };
});
