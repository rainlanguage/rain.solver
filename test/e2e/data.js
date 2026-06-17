require("dotenv").config();
const { ChainId, LiquidityProviders } = require("sushi");
const { USDT, WNATIVE, USDC, ENOSYS_HLN, Token } = require("sushi/currency");

module.exports = [
    [
        // chain id
        ChainId.POLYGON,

        // fork rpc url
        process?.env?.TEST_POLYGON_RPC,

        // block number of fork network
        88634112,

        // tokens to test with
        [
            WNATIVE[ChainId.POLYGON],
            USDC[ChainId.POLYGON],
            new Token({
                chainId: ChainId.POLYGON,
                address: "0xd0e9c8f5Fae381459cf07Ec506C1d2896E8b5df6",
                decimals: 18,
                symbol: "IOEN",
            }),
            new Token({
                chainId: ChainId.POLYGON,
                address: "0x874e178A2f3f3F9d34db862453Cd756E7eAb0381",
                decimals: 18,
                symbol: "GFI",
            }),
        ],

        // addresses with token balance, in order with specified tokens
        [
            "0x13dCa56c1747a0351A8FD23384b593E3dF53CA6d",
            "0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245",
            "0xd6756f5aF54486Abda6bd9b1eee4aB0dBa7C3ef2",
            "0x9294132f9d423b0FD5823aB400133d814fe73016",
        ],

        // liq providers to use for test
        // ideally specify at least one for each univ2 and univ3 protocols
        [
            LiquidityProviders.QuickSwapV2,
            LiquidityProviders.QuickSwapV3,
            LiquidityProviders.GravityFinance,
        ],

        // deposist amounts per token pair order
        ["100", "100", "100", "100"],
    ],
    [
        ChainId.ARBITRUM,
        process?.env?.TEST_ARBITRUM_RPC,
        474263125,
        [WNATIVE[ChainId.ARBITRUM], USDT[ChainId.ARBITRUM]],
        [
            "0xc3e5607cd4ca0d5fe51e09b60ed97a0ae6f874dd",
            "0xdC379823A9a3A2ca9d77C33299551ecDBaBf7A41",
        ],
        [LiquidityProviders.UniswapV3, LiquidityProviders.UniswapV2],
        ["1", "100"],
    ],
    [
        ChainId.FLARE,
        process?.env?.TEST_FLARE_RPC,
        63085192,
        [WNATIVE[ChainId.FLARE], USDT[ChainId.FLARE], ENOSYS_HLN],
        [
            "0x2258e7Ad1D8AC70FAB053CF59c027960e94DB7d1",
            "0xf3b90D35412861DcD35Cb0d4f10D6c840cb60e68",
            "0xd7d1671d77044Ce93d198cC612610a0fd9B8028A",
        ],
        [LiquidityProviders.Enosys, LiquidityProviders.SparkDexV2, LiquidityProviders.SparkDexV3],
        ["1", "100", "100"],
    ],
    [
        ChainId.ETHEREUM,
        process?.env?.TEST_ETH_RPC,
        25333712,
        [
            WNATIVE[ChainId.ETHEREUM],
            USDT[ChainId.ETHEREUM],
            // new Token({
            //     chainId: ChainId.ETHEREUM,
            //     address: "0x922D8563631B03C2c4cf817f4d18f6883AbA0109",
            //     decimals: 18,
            //     symbol: "LOCK"
            // }),
        ],
        [
            "0x6B44ba0a126a2A1a8aa6cD1AdeeD002e141Bcd44",
            "0x13f52026493DcCf09065952d44101C3E42b41ddA",
            // "0x3776100a4b669Ef0d727a81FC69bF50DE74A976c",
        ],
        [
            // LiquidityProviders.SushiSwapV2,
            LiquidityProviders.UniswapV3,
        ],
        ["1", "100", "100"],

        // ob, arb, bot addresses
        // "0xf1224A483ad7F1E9aA46A8CE41229F32d7549A74",
        // "0x96C3673Ee4B0d5303272193BaB0c565B7ce58D7A",
        // "0x22025257BeF969A81eDaC0b343ce82d777931327",
    ],
    [
        ChainId.BASE,
        process?.env?.TEST_BASE_RPC,
        47433654,
        [
            WNATIVE[ChainId.BASE],
            // new Token({
            //     chainId: ChainId.BASE,
            //     address: "0x99b2B1A2aDB02B38222ADcD057783D7e5D1FCC7D",
            //     decimals: 18,
            //     symbol: "WLTH",
            // }),
            new Token({
                chainId: ChainId.BASE,
                address: "0x71DDE9436305D2085331AF4737ec6f1fe876Cf9f",
                decimals: 18,
                symbol: "PAID",
            }),
            new Token({
                chainId: ChainId.BASE,
                address: "0x3982E57fF1b193Ca8eb03D16Db268Bd4B40818f8",
                decimals: 18,
                symbol: "BLOOD",
            }),
        ],
        [
            "0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59",
            // "0xe3715B2a3bB826cd9EC5429eE85B651f95879D34",
            "0x4617C0F3e55930fdD72ec6EA92e79D384987C464",
            "0x7731D522011b4ACE5D812C15539321F373d0E964",
        ],
        [LiquidityProviders.UniswapV3, LiquidityProviders.UniswapV2, LiquidityProviders.BaseSwap],
        ["1", "10000", "10000", "10000"],
    ],
    [
        // unique test for aerodrome slipstream
        ChainId.BASE,
        process?.env?.TEST_BASE_RPC,
        47433654,
        [WNATIVE[ChainId.BASE], USDC[ChainId.BASE]],
        [
            "0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59",
            "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a",
        ],
        [LiquidityProviders.AerodromeSlipstream],
        ["1", "100"],
    ],
    // [
    //     // unique test for aerodrome slipstream
    //     ChainId.BASE,
    //     process?.env?.TEST_BASE_RPC,
    //     47433654,
    //     [
    //         USDC[ChainId.BASE],
    //         new Token({
    //             chainId: ChainId.BASE,
    //             address: "0xfb8718a69aed7726afb3f04d2bd4bfde1bdcb294",
    //             decimals: 6,
    //             symbol: "TRYB",
    //         }),
    //     ],
    //     [
    //         "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a",
    //         "0x8f58955bB4dfF80f956B4683d29b62C984D4657F",
    //     ],
    //     [LiquidityProviders.AerodromeSlipstream],
    //     ["1", "100"],
    //     undefined,
    //     undefined,
    //     undefined,
    //     false,
    // ],
    [
        ChainId.BSC,
        process?.env?.TEST_BSC_RPC,
        104664904,
        [
            WNATIVE[ChainId.BSC],
            new Token({
                chainId: ChainId.BSC,
                address: "0x8f0FB159380176D324542b3a7933F0C2Fd0c2bbf",
                decimals: 7,
                symbol: "TFT",
            }),
            // new Token({
            //     chainId: ChainId.BSC,
            //     address: "0xAD86d0E9764ba90DDD68747D64BFfBd79879a238",
            //     decimals: 18,
            //     symbol: "PAID",
            // }),
        ],
        [
            "0x308000D0169Ebe674B7640f0c415f44c6987d04D",
            "0x66803c0B34B1baCCb68fF515f76cd63ba48a2039",
            // "0x604b2B06ad0D5a2f8ef4383626f6dD37E780D090",
        ],
        [LiquidityProviders.PancakeSwapV2, LiquidityProviders.PancakeSwapV3],
        ["1", "100000"],
    ],
    [
        ChainId.LINEA,
        process?.env?.TEST_LINEA_RPC,
        31059310,
        [
            WNATIVE[ChainId.LINEA],
            USDC[ChainId.LINEA],
            // new Token({
            //     chainId: ChainId.LINEA,
            //     address: "0x4Ea77a86d6E70FfE8Bb947FC86D68a7F086f198a",
            //     decimals: 18,
            //     symbol: "CLIP",
            // }),
        ],
        [
            "0x8AF83Ebf3e0F2465f6E9B55dBbC77e7995948168",
            "0x555CE236C0220695b68341bc48C68d52210cC35b",
            // "0x0000619b2b909a6a422c18eb804b92f798370705",
        ],
        [LiquidityProviders.LynexV1, LiquidityProviders.LynexV2],
        ["1", "100"],
    ],
    // [
    //     ChainId.MATCHAIN,
    //     process?.env?.TEST_MATCHAIN_RPC,
    //     29952210,
    //     [WNATIVE[ChainId.MATCHAIN], USDT[ChainId.MATCHAIN]],
    //     [
    //         "0x33d8Fa2Cd11F721A0e9A0105e4178F1E489c16f9",
    //         "0x5887DD31D31745EA58F29d6d1528C89aEc418991",
    //     ],
    //     [LiquidityProviders.MSwap],
    //     ["0.01", "100"],
    // ],
];
