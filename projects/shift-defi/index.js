const sdk = require("@defillama/sdk");

const abi = {
    getContainers: "function getContainers() view returns (address[] containers, uint256[] weights)",
    containerType: "function containerType() view returns (uint8)",
    getStrategies: "function getStrategies() view returns (address[])",
    peerContainer: "function peerContainer() view returns (address)",
    remoteChainId: "function remoteChainId() view returns (uint256)",
    getStateIds: "function getStateIds() view returns (bytes32[])",
    stateNav: "function stateNav(bytes32 stateId) view returns (uint256)",
    notion: "address:notion",
};

const ContainerType = {
    LOCAL: 0,
    PRINCIPAL: 1,
    AGENT: 2,
};

const ZERO = "0x0000000000000000000000000000000000000000";

const vaults = {
    ethereum: ["0x1d71c888961c4600cF0E31F6196b4dA7fE72e4B3"],
}

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

function sumBigInt(values) {
    return values.reduce((acc, value) => acc + BigInt(value || 0), 0n);
}

function pickContainers(res) {
    if (Array.isArray(res?.containers)) return res.containers;
    if (Array.isArray(res?.[0])) return res[0];
    return res;
}

async function getVaultContainers(api, vaultAddress) {
    const res = await api.call({ target: vaultAddress, abi: abi.getContainers });
    return (pickContainers(res) || []).filter((container) => container && container !== ZERO);
}

async function getContainerType(api, container) {
    return Number(await api.call({ target: container, abi: abi.containerType }));
}

async function getPeerContainer(api, container) {
    return api.call({ target: container, abi: abi.peerContainer });
}

async function getContainerStrategies(api, container) {
    const strategies = await api.call({ target: container, abi: abi.getStrategies });
    return (strategies || []).filter((strategy) => strategy && strategy !== ZERO);
}

async function getStateIds(api, strategy) {
    return (await api.call({ target: strategy, abi: abi.getStateIds })) || [];
}

async function getStateNavs(api, strategy, stateIds) {
    if (!stateIds.length) return [];
    return api.multiCall({
        abi: abi.stateNav,
        calls: stateIds.map((stateId) => ({ target: strategy, params: [stateId] })),
    });
}

async function getStrategyTvl(api, strategy) {
    const stateIds = await getStateIds(api, strategy);
    const navs = await getStateNavs(api, strategy, stateIds);
    return sumBigInt(navs);
}

async function getLocalContainerTvl(api, container) {
    const strategies = await getContainerStrategies(api, container);
    const navs = await Promise.all(strategies.map((strategy) => getStrategyTvl(api, strategy)));
    return sumBigInt(navs);
}

async function getRemoteChainId(api, container) {
    return api.call({ target: container, abi: abi.remoteChainId });
}

async function getPrincipalContainerTvl(api, container) {
    const [peer, remoteChainId] = await Promise.all([
        getPeerContainer(api, container),
        getRemoteChainId(api, container),
    ]);
    if (!peer || peer === ZERO) return 0n;
    const peerApi = getApiForChain(api, remoteChainId);
    return getLocalContainerTvl(peerApi, peer);
}

async function getContainerTvl(api, container, type) {
    const containerType = type ?? await getContainerType(api, container);
    if (containerType === ContainerType.LOCAL) return getLocalContainerTvl(api, container);
    if (containerType === ContainerType.PRINCIPAL) return getPrincipalContainerTvl(api, container);
    throw new Error(`Unsupported container type ${containerType} at ${container} on ${api.chain}`);
}

async function getVaultTvl(api, vaultAddress) {
    const containers = await getVaultContainers(api, vaultAddress);
    if (!containers.length) return 0n;

    const types = await api.multiCall({ abi: abi.containerType, calls: containers });
    const navs = await Promise.all(
        containers.map((container, i) => getContainerTvl(api, container, Number(types[i])))
    );
    return sumBigInt(navs);
}

const NAV_DECIMALS = 18n;

function scaleNavToToken(nav, tokenDecimals) {
    const tokenDec = BigInt(tokenDecimals);
    if (tokenDec === NAV_DECIMALS) return nav;
    if (tokenDec < NAV_DECIMALS) return nav / (10n ** (NAV_DECIMALS - tokenDec));
    return nav * (10n ** (tokenDec - NAV_DECIMALS));
}

async function getVaultNotion(api, vaultAddress) {
    return api.call({ target: vaultAddress, abi: abi.notion });
}

async function getTokenDecimals(api, token) {
    return api.call({ target: token, abi: "erc20:decimals" });
}

async function addVaultTvl(api, vaultAddress) {
    const nav = await getVaultTvl(api, vaultAddress);
    const notion = await getVaultNotion(api, vaultAddress);
    const decimals = await getTokenDecimals(api, notion);
    api.add(notion, scaleNavToToken(nav, decimals));
}

async function tvl(api) {
    const chainVaults = vaults[api.chain] || [];
    for (const vaultAddress of chainVaults) {
        await addVaultTvl(api, vaultAddress);
    }
}

module.exports = {
    methodology: "The total value of all strategies that make up the Vault portfolio. TVL is calculated as the sum of the NAVs of all strategies within the Vault.",
};

Object.keys(vaults).forEach((chain) => {
    module.exports[chain] = { tvl };
});
