import { ChainId } from "sushi";

/** Keeps Stabull protocol contract addresses */
export namespace StabullConstants {
    /** Supported chains by the Stabull protocol */
    export const SupportedChains = [ChainId.ETHEREUM, ChainId.POLYGON, ChainId.BASE] as const;

    /** Determines if the given chain is supported by the Stabull protocol */
    export function isChainSupported(chainId: number): chainId is (typeof SupportedChains)[number] {
        return SupportedChains.includes(chainId as any);
    }

    /** Stabull protocol router addresses per chain */
    export const Routers = {
        [ChainId.ETHEREUM]: "0x871af97122d08890193e8d6465015f6d9e2889b2",
        [ChainId.POLYGON]: "0x0c1f53e7b5a770f4c0d4bef139f752eeb08de88d",
        [ChainId.BASE]: "0x4b82759d385e905c85d1fcf7811ed33b738965a0",
    } as const;

    /** Stabull protocol supported tokens per chain */
    export const Tokens = {
        [ChainId.ETHEREUM]: {
            EURS: "0xdb25f211ab05b1c97d595516f45794528a807ad8",
            GYEN: "0xc08512927d12348f6620a698105e1baac6ecd911",
            NZDS: "0xda446fad08277b4d2591536f204e018f32b6831c",
            TRYB: "0x2c537e5624e4af88a7ae4060c022609376c8d0eb",
            USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        },
        [ChainId.POLYGON]: {
            BRZ: "0x4ed141110f6eeeaba9a1df36d8c26f684d2475dc",
            COPM: "0x12050c705152931cfee3dd56c52fb09dea816c23",
            DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
            EURS: "0xe111178a87a3bff0c8d18decba5798827539ae99",
            NZDS: "0xfbbe4b730e1e77d02dc40fedf9438e2802eab3b5",
            OFD: "0x9cfb3b1b217b41c4e748774368099dd8dd7e89a1",
            PAXG: "0x553d3d295e0f695b9228246232edf400ed3560b5",
            PHPC: "0x87a25dc121db52369f4a9971f664ae5e372cf69a",
            TRYB: "0x4fb71290ac171e1d144f7221d882becac7196eb5",
            USDC: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
            USDT: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
            XSGD: "0xdc3326e71d45186f113a2f448984ca0e8d201995",
            ZCHF: "0x02567e4b14b25549331fcee2b56c647a8bab16fd",
        },
        [ChainId.BASE]: {
            BRZ: "0xe9185ee218cae427af7b9764a011bb89fea761b4",
            EURC: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
            MXNe: "0x269cae7dc59803e5c596c95756faeebb6030e0af",
            TRYB: "0xfb8718a69aed7726afb3f04d2bd4bfde1bdcb294",
            ZARP: "0xb755506531786c8ac63b756bab1ac387bacb0c04",
            ZCHF: "0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553",
            OFD: "0x7479791022eb1030bbc3b09f6575c5db4ddc0b90",
            USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        },
    } as const;

    /** List of Stabull protocol supported tokens per chain */
    export const TokenList = {
        [ChainId.ETHEREUM]: new Set(Object.values(Tokens[ChainId.ETHEREUM])) as Set<string>,
        [ChainId.POLYGON]: new Set(Object.values(Tokens[ChainId.POLYGON])) as Set<string>,
        [ChainId.BASE]: new Set(Object.values(Tokens[ChainId.BASE])) as Set<string>,
    } as const;

    /** Stabull protocol quote currencies per chain */
    export const QuoteCurrency = {
        [ChainId.ETHEREUM]: Tokens[ChainId.ETHEREUM].USDC,
        [ChainId.POLYGON]: Tokens[ChainId.POLYGON].USDC,
        [ChainId.BASE]: Tokens[ChainId.BASE].USDC,
    } as const;

    /** Stabull protocol deployed pools (token pair pools) per chain */
    export const Pools = {
        [ChainId.ETHEREUM]: {
            "GYEN-USDC": "0x01e4013c478d7f02112c3cf178f2771c842edbd0",
            "EURS-USDC": "0x865040f92ac6cca1b9683c03d843799d8e6d1282",
            "NZDS-USDC": "0xe37d763c7c4cdd9a8f085f7db70139a0843529f3",
            "TRYB-USDC": "0xc1a195fdb17da5771d470a232545550a7d264809",
        },
        [ChainId.POLYGON]: {
            "BRZ-USDC": "0xce0abd182d2cf5844f2a0cb52cfcc55d4ff4fcba",
            "COPM-USDC": "0x9caa728e1935c8b332dc4e9ec9d57666fc9e7ff4",
            "DAI-USDC": "0xa52508b1822ca9261b33213b233694f846abd0ed",
            "EURS-USDC": "0xf80b3a8977d34a443a836a380b2fce69a1a4e819",
            "NZDS-USDC": "0xdcb7efaca996fe2985138bf31b647efcd1d0901a",
            "OFD-USDC": "0x5cc08ce8fd0f66d83cb39300b268602514e2926b",
            "PAXG-USDC": "0xbefc1cbf4a8c4a8af76d2e35287f11a3ac4fca29",
            "PHPC-USDC": "0x1233003461f654cf1c0d7db19e753badef05a87f",
            "TRYB-USDC": "0x55bdf7f0223e8b1d509141a8d852dd86b3553d59",
            "USDT-USDC": "0x3d4436ba3ae7e0e6361c83ab940ea779cd598206",
            "XSGD-USDC": "0x509aacb7746166252ecb0d62bfba097cc9731e20",
            "ZCHF-USDC": "0xd840d0361c36709e62c13ec42253dc0c3e326c1d",
        },
        [ChainId.BASE]: {
            "BRZ-USDC": "0x8a908ae045e611307755a91f4d6ecd04ed31eb1b",
            "EURC-USDC": "0x2a645d27efe5c8f5afc63856d2509ea20f81a0b2",
            "MXNE-USDC": "0xc642e57d55853baa61e7f7c4894894235f221f82",
            "TRYB-USDC": "0x1f039c1dfe7eb98c49d11dbf74b476853127e963",
            "ZARP-USDC": "0x63129f8948225fe08b9c921186bafa27e6710833",
            "ZCHF-USDC": "0xc77c42baa1bdf2708c5ef8cfca3533b3e09b058f",
            "OFD-USDC": "0x27cd7e6837e2a043ba760a8f67f73b8f0b7de8f3",
        },
    } as const;
}
