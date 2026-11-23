# 0G solver deployment

This runbook adds a solver instance for 0G mainnet (chain id 16661). The
instance clears the ST0x orders of the RaindexV6 orderbook on 0G. It runs as
its own container, with its own env file and volume. Issue:
[RAI-4611](https://linear.app/makeitrain/issue/RAI-4611).

The on-chain facts below were read on 2026-11-23, at 0G block 51,157,645.

## Prerequisites

Do not start the instance before all of these are done.

1. 0G chain support in `lib/sushiswap`
   ([sushiswap#54](https://github.com/rainlanguage/sushiswap/pull/54),
   [sushiswap#55](https://github.com/rainlanguage/sushiswap/pull/55)), then a
   submodule bump in this repo.
2. RouteProcessor6 support in the solver, RouteProcessor6 on 0G, and a
   RaindexV6 arb contract that routes through it.
3. DISPaiR `0_1_9` on 0G
   ([RAI-4890](https://linear.app/makeitrain/issue/RAI-4890)), with its
   `Rainlang` directory.
4. The 0G oracle ([RAI-4610](https://linear.app/makeitrain/issue/RAI-4610)).
5. ST0x orders on 0G
   ([RAI-4609](https://linear.app/makeitrain/issue/RAI-4609)), on chain and in
   the subgraph.
6. A funded solver wallet on 0G.
7. A route from one token of each order to W0G, for example USDC.e to W0G,
   in the 0G liquidity providers of `lib/sushiswap`. Add Zia to them (see
   [Liquidity](#liquidity)), or make sure that Comfy has a W0G/USDC.e pool.

Why each one blocks:

1. Without 0G in `lib/sushiswap`, the solver stops at startup with
   `network with id 16661 is not supported` (`getChainConfig` in
   `src/state/chain.ts`). Robinhood came the same way:
   [sushiswap#50](https://github.com/rainlanguage/sushiswap/pull/50) and a
   submodule bump.
2. Comfy (comfy.fun), the DEX named for 0G, is a PancakeSwap Infinity CL
   deployment. RouteProcessor4 cannot swap on it. The solver encodes every
   router trade for RouteProcessor4 (`Router.routeProcessor4Params` in
   `src/router/sushi/index.ts`), and the RaindexV6 route processor arb on 0G
   has the RouteProcessor4 address in its code. So when `lib/sushiswap` has
   Comfy, a router trade through a Comfy pool cannot succeed.
3. When `DISPAIR_V6` is unset, or points at an address with no code, the
   solver loads no v6 contracts and trades nothing (`resolveVersionContracts`
   in `src/state/contracts.ts`).
4. The solver already trusts every https oracle host under `t0trade.com`
   (`src/oracle/types.ts`), so the 0G oracle needs no solver change.
5. The log sync follows only the orderbooks that the subgraph lists at
   startup (`EventSyncManager.init` in `src/events/manager.ts`). The 0G
   subgraph lists no orderbook until the first order event. An instance that
   starts before that never sees the 0G orders. Start it, or restart it,
   after the first 0G order is on chain and in the subgraph. Until ST0x pools
   exist on a 0G DEX, the instance clears only crossing orders of two
   different owners (see [Liquidity](#liquidity)). If all the ST0x orders on
   0G have one owner, expect no trades.
6. Without gas, the trades cannot go out.
7. The solver prices the gas of a trade in the tokens of the order. When
   neither token of an order has a route to W0G, `processOrder`
   (`src/core/process/order.ts`) skips the order with `FailedToGetEthPrice`.
   `GAS_COVER` defaults to 100. With `GAS_COVER=0`, the solver does not skip
   the order, but it also does not check that a trade pays for its gas, so a
   trade can cost the wallet more gas than it earns. Keep the default.

## Liquidity

No DEX on 0G has ST0x token pools yet, because no ST0x token is minted on
0G. So router trades find no route for an ST0x token. The inter-orderbook mode
needs a second orderbook, and 0G has only the RaindexV6 orderbook. So until
pools exist, only intra-orderbook clears (one 0G order against another) can
happen. The intra-orderbook mode pairs only orders of different owners
(`src/core/modes/intra/index.ts`).

The gas price of prerequisite 7 comes from a quote, not a swap, so any pool
that `lib/sushiswap` knows can give it.
[sushiswap#55](https://github.com/rainlanguage/sushiswap/pull/55) adds Comfy
only. The W0G/USDC.e liquidity on 0G is on UniswapV3 forks:

| DEX | Factory | W0G/USDC.e pool |
| --- | ------- | --------------- |
| Zia | `0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70` | 0.3%: `0x23336572435eC92d25eF0dD2D468B2a1aBF7BB4f`, about 8,541 USDC.e |
| Oku (UniswapV3) | `0xBDDB3aCF0A90029a1e7ebC3F82C7D9391C429A75` | 1%: `0x1b9e724A9b3c0f9Ff1366705A8Bb86e56d192fd7`, almost empty |

Their pools call `uniswapV3SwapCallback`, so RouteProcessor4 can also swap on
them.

## Contracts on 0G

The RaindexV6 orderbook, the three arb contracts and RouteProcessor4 are the
Zoltu deployments of the raindex `0_1_15` release. Each of them has code on
0G with the same code hash as on Robinhood, so each has the same address on
both chains. The DISPaiR comes from rainlang.deploy `0_1_9`.

| Contract | Address | Env var | Trade mode |
| -------- | ------- | ------- | ---------- |
| RaindexV6 | `0x37FC0EFec37D19f8A221aa4F8F7600C9ba2AcD20` | `INCLUDE_ORDERBOOKS` | all |
| RaindexV6 arb through RouteProcessor6 (prerequisite 2) | not deployed | `ARB_ADDRESS_V6` | router (`arb5`) |
| RouteProcessorRaindexV6ArbOrderTaker | `0x1350420cbf3E9eb8F1734bbe466e0F303579eE24` | none, see below | none |
| GenericPoolRaindexV6ArbOrderTaker | `0xE84c106B0A89A164d2D65205B9EBAE37c15Fd84a` | `GENERIC_ARB_ADDRESS_V6` | inter-orderbook (`arb5`) |
| GenericPoolRaindexV6FlashBorrower | `0x032d9D94A79909F3b337ECFE6f73f4e86bA79c7E` | none, see below | none |
| RouteProcessor4 | `0x6E2d0e71d900474b262E545Bc4C98b71ab368d21` | none, it comes from `lib/sushiswap` | router |
| `Rainlang` directory, DISPaiR `0_1_9` | `0x820FB8ae43350f6F4F60117955751b0a6777aC54` (not on 0G on 2026-11-23) | `DISPAIR_V6` | all |

Do not set `ARB_ADDRESS_V6` to the RouteProcessorRaindexV6ArbOrderTaker
`0x1350420cbf3E9eb8F1734bbe466e0F303579eE24`. It routes through
RouteProcessor4, which cannot swap on Comfy (prerequisite 2). Set
`ARB_ADDRESS_V6` to the RouteProcessor6 arb of prerequisite 2, or to the
variable that the RouteProcessor6 support adds.

Do not set `RAINDEX_ARB_ADDRESS_V6` to the flash borrower. It has
`arb4(address,TakeOrdersConfigV5,bytes,TaskV2)` (selector `0x8c18e4ba`). The
raindex router mode calls `arb4(address,TakeOrdersConfigV5[],bytes,TaskV2)`
(selector `0xc55377d6`), which it does not have. Leave the variable unset, so
the raindex router mode finds no trade.

Set `DISPAIR_V6` to the `Rainlang` directory, not to the expression deployer
`0xb90c299a8321fbdd8D0F367e560f5341F840dA3F`. On Robinhood, the directory
answers `interpreterAddress()`, `storeAddress()` and
`expressionDeployerAddress()`. The expression deployer answers none of these,
and no `I_INTERPRETER()` or `I_STORE()` either, so with it the solver loads no
v6 contracts.

## Instance environment

Start from the config of a RaindexV6 instance on another chain, then change
the values below. The names are the env vars of `config.env.yaml`. If the
instance reads a config yaml, set the matching fields there.

```dotenv
# Secrets. Keep them out of every repository.
# RPC_URL and WS_RPC: a 0G RPC for reads, https and wss.
RPC_URL=url=<0G rpc, https>
WS_RPC=<0G rpc, wss>
# WRITE_RPC: a 0G RPC that relays transactions. The trades go out through it.
WRITE_RPC=url=<0G rpc that relays transactions>
SUBGRAPH=v6=<0G RaindexV6 subgraph url>
BOT_WALLET_PRIVATEKEY=<0G solver wallet key>

# Contracts
INCLUDE_ORDERBOOKS=0x37FC0EFec37D19f8A221aa4F8F7600C9ba2AcD20
ARB_ADDRESS_V6=<RaindexV6 RouteProcessor6 arb, prerequisite 2>
GENERIC_ARB_ADDRESS_V6=0xE84c106B0A89A164d2D65205B9EBAE37c15Fd84a
DISPAIR_V6=0x820FB8ae43350f6F4F60117955751b0a6777aC54

# A 0G block takes about 0.83 s. A receipt wait times out after 3 block
# times, so 1000 gives 3 s.
BLOCK_TIME=1000

# The amount is in 0G.
BOT_MIN_BALANCE=1

# Only the trades use WRITE_RPC. The wallet top-ups, sweeps, gas conversion
# and vault self-funding go through RPC_URL. Keep these off and use one
# wallet, so that RPC_URL does not have to relay transactions.
SWEEP_WALLET_TIME=0
CONVERT_TO_GAS_TIME=0

TRACER_SERVICE_NAME=zerog-bot
```

Remove these from the copy:

- The wallet variables: `MNEMONIC`, `WALLET_COUNT`, `TOPUP_AMOUNT` and
  `SELF_FUND_ORDERS`.
- The contract variables other than the four above: `RAINDEX_ARB_ADDRESS_V6`,
  `BALANCER_ARB_ADDRESS_V6`, `STABULL_ARB_ADDRESS_V6`, and every v4 and v5
  contract variable.
- The trade-mode lists `ROUTER_ENABLED_ORDERBOOKS`,
  `INTER_ENABLED_ORDERBOOKS`, `INTRA_ENABLED_ORDERBOOKS` and
  `RAINDEX_ENABLED_ORDERBOOKS`. RaindexV6 has the same address on 0G as on the
  other chains, so a copied list applies to 0G too. When an orderbook is in
  one of these lists, only the listed modes run for it
  (`getEnabledTradeTypeFunctions` in `src/core/modes/index.ts`). For example,
  a copied `ROUTER_ENABLED_ORDERBOOKS` turns off the intra-orderbook clears.
- The filters `EXCLUDE_ORDERBOOKS`, `INCLUDE_ORDERS`, `EXCLUDE_ORDERS`,
  `INCLUDE_OWNERS` and `EXCLUDE_OWNERS`.
- Any `LIQUIDITY_PROVIDERS` list. With no `LIQUIDITY_PROVIDERS`, the solver
  uses every provider that `lib/sushiswap` has for 0G.

If you need one of these on 0G, set it for 0G on purpose.

For `WRITE_RPC`, use an endpoint that takes its key in the URL. The public
`https://evmrpc.0g.ai` can be a second, low-weight entry.

## Gas and the wallet

The gas token is 0G. The base fee was 7 wei and the fee history tip was 4
gwei, so `TX_TYPE=eip1559` (the default) works. An arb transaction of 1M gas
costs about 0.004 0G.

1. Make a new key for 0G only. Share only its address.
2. Fund the address with 0G, for example 20 0G. That pays for about 5,000
   transactions of 1M gas.
3. Check the balance before the first start. Below `BOT_MIN_BALANCE`, the
   wallet balance check reports a high-severity low-gas error. The solver
   keeps trading until the gas runs out.

## Rollout

1. Do prerequisites 1, 2, 3, 4, 6 and 7. Each push to `master` publishes
   `rainprotocol/rain.solver:master`.
2. Make a compose project for 0G only, with its own project name, env file
   and external volume. Do not use the repo `compose.yaml` as it is. It pulls
   `rainprotocol/arb-bot`, and it names the volume
   `rainprotocol-arb-bot-${DOCKER_CHANNEL}`, so every instance on the same
   channel gets the same volume. Set the image to
   `rainprotocol/rain.solver:master`, and give the volume a name that is only
   for 0G. Create the volume first (see "Up & volumes" in the README).
3. Wait until the first 0G order is on chain and the subgraph lists the
   orderbook (prerequisite 5). Then start the instance with
   `docker compose -p <0G project> up -d`.
4. If a Verify step fails, stop the instance with
   `docker compose -p <0G project> down`. This stops only the 0G project.
   With `restart: always`, a startup error repeats until you stop it.

## Verify

1. The `startup` span has no error.
2. Each round span has `meta.chainId` 16661, and `meta.orderbooks` has the
   RaindexV6 address. An empty `meta.orderbooks` means that the instance
   started too early (prerequisite 5). Restart it.
3. `meta.contracts.v6` of the round span has `sushiArb` and `genericArb`
   equal to `ARB_ADDRESS_V6` and `GENERIC_ARB_ADDRESS_V6`, in lowercase. It
   has no `0x820F…aC54`: its `dispair` has the `deployer`, `interpreter` and
   `store` that the `Rainlang` directory returns. `N/A` means that
   `DISPAIR_V6` did not resolve (prerequisite 3).
4. The first trade transaction succeeds on <https://chainscan.0g.ai>.
5. The wallet balance goes down only by the gas of the trades.
