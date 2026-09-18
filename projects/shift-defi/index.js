const sdk = require("@defillama/sdk");
const { nullAddress } = require("../helper/tokenMapping");

const TVL_REPORTER = ""; // same address on every chain
const NAV_DECIMALS = 18n;

const abi = {
  getContainers: "function getContainers() view returns (address[] containers, uint256[] weights)",
  containerType: "uint8:containerType",
  remoteChainId: "uint256:remoteChainId",
  isReshuffling: "bool:isReshuffling",
  getStrategiesNav: "uint256:getStrategiesNav",
  getPreReshufflingSnapshot: "uint256:getPreReshufflingSnapshot",
  notion: "address:notion",
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
}

async function tvl(api) {
  await Promise.all((vaults[api.chain] || []).map((vault) => addVaultTvl(api, vault)));
}

module.exports = {
  methodology:
    "TVL is the sum of TvlReporter values across all chains with Local and Agent containers. If the vault is reshuffling, pre-reshuffling snapshots are used instead of live strategy NAVs.",
};

Object.keys(vaults).forEach((chain) => {
  module.exports[chain] = { tvl };
});
