const sdk = require("@defillama/sdk");
const { nullAddress } = require("../helper/tokenMapping");

const DEFII_OWNER = "0x1B23418E688D2BB8EB9249D567Ec4bf4aA427CaC"; // KYC factory defii owner
const KYC_FACTORY = "0xf978187e7142D857D713503b3C3decD5778F2ACC"; // Ethereum KYC Factory
const TVL_REPORTER = "0x0A4420823e2c415C9D5ABC668b0915b62f7409Fb"; // Same address on every chain
const USDC_USD_FEED = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6"; // Chainlink USDC/USD
const NAV_DECIMALS = 18n;
const PRINCIPAL_CONTAINER = 1;

const abi = {
  getContainers: "function getContainers() view returns (address[] containers, uint256[] weights)",
  containerType: "uint8:containerType",
  remoteChainId: "uint256:remoteChainId",
  isReshuffling: "bool:isReshuffling",
  getStrategiesNav: "uint256:getStrategiesNav",
  getPreReshufflingSnapshot: "uint256:getPreReshufflingSnapshot",
  notion: "address:notion",
  tvl: "function tvl(address account) view returns (uint256 total)",
  latestRoundData:
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  decimals: "uint8:decimals",
};

const vaults = {
  ethereum: ["0x1d71c888961c4600cF0E31F6196b4dA7fE72e4B3"],
};

const chainNamesById = Object.fromEntries(
  Object.entries(sdk.providerListJSON ?? {})
    .filter(([, { chainId }]) => chainId)
    .map(([name, { chainId }]) => [chainId, name])
);

async function getVaultNav(api, vault) {
  const [containersRes, isReshuffling] = await Promise.all([
    api.call({ target: vault, abi: abi.getContainers }),
    api.call({ target: vault, abi: abi.isReshuffling }),
  ]);
  const containers = (containersRes.containers ?? containersRes[0] ?? []).filter(
    (c) => c && c !== nullAddress
  );
  if (!containers.length) return 0n;

  const containerTypes = await api.multiCall({ abi: abi.containerType, calls: containers });
  const principalContainers = containers.filter(
    (_, index) => Number(containerTypes[index]) === PRINCIPAL_CONTAINER
  );
  const chainIds = new Set();

  if (principalContainers.length < containers.length) {
    chainIds.add(Number(api.chainId));
  }
  if (principalContainers.length) {
    const remoteChainIds = await api.multiCall({
      abi: abi.remoteChainId,
      calls: principalContainers,
    });
    remoteChainIds.forEach((chainId) => chainIds.add(Number(chainId)));
  }

  const navAbi = isReshuffling ? abi.getPreReshufflingSnapshot : abi.getStrategiesNav;
  const navs = await Promise.all([...chainIds].map((chainId) => {
    if (chainId === Number(api.chainId)) {
      return api.call({ target: TVL_REPORTER, abi: navAbi });
    }

    const chain = chainNamesById[chainId];
    if (!chain) throw new Error(`Unknown chainId ${chainId}`);
    const chainApi = new sdk.ChainApi({ chain, timestamp: api.timestamp });
    return chainApi.call({ target: TVL_REPORTER, abi: navAbi });
  }));
  return navs.reduce((total, nav) => total + BigInt(nav), 0n);
}

async function tvl(api) {
  const vaultTokens = await Promise.all(
    (vaults[api.chain] ?? []).map(async (vault) => {
      const [nav, notion] = await Promise.all([
        getVaultNav(api, vault),
        api.call({ target: vault, abi: abi.notion }),
      ]);
      const decimals = BigInt(await api.call({ target: notion, abi: abi.decimals }));
      const decimalDifference = decimals - NAV_DECIMALS;
      const tokenAmount = decimalDifference < 0n
        ? nav / 10n ** -decimalDifference
        : nav * 10n ** decimalDifference;

      api.add(notion, tokenAmount);
      return { notion, decimals };
    })
  );

  if (!vaultTokens.length) return;

  const [{ notion, decimals }] = vaultTokens;
  const [kycTvl, round, oracleDecimals] = await Promise.all([
    api.call({ target: KYC_FACTORY, abi: abi.tvl, params: [DEFII_OWNER] }),
    api.call({ target: USDC_USD_FEED, abi: abi.latestRoundData }),
    api.call({ target: USDC_USD_FEED, abi: "uint8:decimals" }),
  ]);
  const usdcPrice = BigInt(round.answer ?? round[1]);
  if (usdcPrice <= 0n) throw new Error("Invalid USDC/USD price");

  const kycTokenAmount = (
    BigInt(kycTvl) * 10n ** decimals * 10n ** BigInt(oracleDecimals)
  ) / (usdcPrice * 10n ** NAV_DECIMALS);
  api.add(notion, kycTokenAmount);
}

module.exports = {
  methodology:
    "Shift DeFi's total protocol TVL is calculated as the sum of the TVLs of all Vaults within the ecosystem. Each Vault's TVL is calculated as the sum of the NAVs of all strategies that make up the Vault's portfolio.",
};

Object.keys(vaults).forEach((chain) => {
  module.exports[chain] = { tvl };
});
