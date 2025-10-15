import { ABI } from "../common";
import { AppOptions } from "../config";
import { TradeType } from "../core/types";
import { Pair } from "../order";
import { resolveVersionContracts, SolverContracts, versionAddressGetter } from "./contracts";
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("SolverContracts.fromAppOptions", () => {
    let mockClient: any;
    let mockAppOptions: AppOptions;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create mock client
        mockClient = {
            readContract: vi.fn(),
        };

        // Mock app options with all contract addresses
        mockAppOptions = {
            contracts: {
                v4: {
                    dispair: "0xv4dispair" as `0x${string}`,
                    sushiArb: "0xv4sushiArb" as `0x${string}`,
                    genericArb: "0xv4genericArb" as `0x${string}`,
                    balancerArb: "0xv4balancerArb" as `0x${string}`,
                    stabullArb: "0xv4stabullArb" as `0x${string}`,
                },
                v5: {
                    dispair: "0xv5dispair" as `0x${string}`,
                    sushiArb: "0xv5sushiArb" as `0x${string}`,
                    genericArb: "0xv5genericArb" as `0x${string}`,
                    balancerArb: "0xv5balancerArb" as `0x${string}`,
                    stabullArb: "0xv5stabullArb" as `0x${string}`,
                },
            },
        } as AppOptions;
    });

    it("should create SolverContracts with both v4 and v5 when all addresses are available", async () => {
        // Mock contract calls to return interpreter and store addresses
        mockClient.readContract
            .mockResolvedValueOnce("0xv4interpreter" as `0x${string}`) // v4 interpreter
            .mockResolvedValueOnce("0xv4store" as `0x${string}`) // v4 store
            .mockResolvedValueOnce("0xv5interpreter" as `0x${string}`) // v5 interpreter
            .mockResolvedValueOnce("0xv5store" as `0x${string}`); // v5 store

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: {
                sushiArb: "0xv4sushiArb",
                genericArb: "0xv4genericArb",
                balancerArb: "0xv4balancerArb",
                stabullArb: "0xv4stabullArb",
                dispair: {
                    deployer: "0xv4dispair",
                    interpreter: "0xv4interpreter",
                    store: "0xv4store",
                },
            },
            v5: {
                sushiArb: "0xv5sushiArb",
                genericArb: "0xv5genericArb",
                balancerArb: "0xv5balancerArb",
                stabullArb: "0xv5stabullArb",
                dispair: {
                    deployer: "0xv5dispair",
                    interpreter: "0xv5interpreter",
                    store: "0xv5store",
                },
            },
            getAddressesForTrade: expect.any(Function),
        });

        // Verify contract calls
        expect(mockClient.readContract).toHaveBeenCalledTimes(4);
        expect(mockClient.readContract).toHaveBeenNthCalledWith(1, {
            address: "0xv4dispair",
            abi: ABI.Deployer.Primary.Deployer,
            functionName: "iInterpreter",
        });
        expect(mockClient.readContract).toHaveBeenNthCalledWith(2, {
            address: "0xv4dispair",
            abi: ABI.Deployer.Primary.Deployer,
            functionName: "iStore",
        });
        expect(mockClient.readContract).toHaveBeenNthCalledWith(3, {
            address: "0xv5dispair",
            abi: ABI.Deployer.Primary.Deployer,
            functionName: "iInterpreter",
        });
        expect(mockClient.readContract).toHaveBeenNthCalledWith(4, {
            address: "0xv5dispair",
            abi: ABI.Deployer.Primary.Deployer,
            functionName: "iStore",
        });
    });

    it("should handle missing v4 contracts gracefully", async () => {
        mockAppOptions.contracts.v4 = undefined;

        // Only mock v5 calls
        mockClient.readContract
            .mockResolvedValueOnce("0xv5interpreter" as `0x${string}`) // v5 interpreter
            .mockResolvedValueOnce("0xv5store" as `0x${string}`); // v5 store

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: undefined,
            v5: {
                sushiArb: "0xv5sushiArb",
                genericArb: "0xv5genericArb",
                balancerArb: "0xv5balancerArb",
                stabullArb: "0xv5stabullArb",
                dispair: {
                    deployer: "0xv5dispair",
                    interpreter: "0xv5interpreter",
                    store: "0xv5store",
                },
            },
            getAddressesForTrade: expect.any(Function),
        });

        expect(mockClient.readContract).toHaveBeenCalledTimes(2);
    });

    it("should handle missing v5 contracts gracefully", async () => {
        mockAppOptions.contracts.v5 = undefined;

        // Only mock v4 calls
        mockClient.readContract
            .mockResolvedValueOnce("0xv4interpreter" as `0x${string}`) // v4 interpreter
            .mockResolvedValueOnce("0xv4store" as `0x${string}`); // v4 store

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: {
                sushiArb: "0xv4sushiArb",
                genericArb: "0xv4genericArb",
                balancerArb: "0xv4balancerArb",
                stabullArb: "0xv4stabullArb",
                dispair: {
                    deployer: "0xv4dispair",
                    interpreter: "0xv4interpreter",
                    store: "0xv4store",
                },
            },
            v5: undefined,
            getAddressesForTrade: expect.any(Function),
        });

        expect(mockClient.readContract).toHaveBeenCalledTimes(2);
    });

    it("should handle missing dispair address", async () => {
        mockAppOptions.contracts.v4!.dispair = undefined as any;
        mockAppOptions.contracts.v5!.dispair = undefined as any;

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: undefined,
            v5: undefined,
            getAddressesForTrade: expect.any(Function),
        });

        expect(mockClient.readContract).not.toHaveBeenCalled();
    });

    it("should handle contract read errors gracefully", async () => {
        // Mock contract calls to throw errors
        mockClient.readContract.mockRejectedValue(new Error("Contract read failed"));

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: undefined,
            v5: undefined,
            getAddressesForTrade: expect.any(Function),
        });

        expect(mockClient.readContract).toHaveBeenCalledTimes(2);
    });

    it("should handle partial contract read errors", async () => {
        // Mock v4 to succeed, v5 to fail
        mockClient.readContract
            .mockResolvedValueOnce("0xv4interpreter" as `0x${string}`) // v4 interpreter
            .mockResolvedValueOnce("0xv4store" as `0x${string}`) // v4 store
            .mockRejectedValueOnce(new Error("v5 interpreter failed")) // v5 interpreter error
            .mockRejectedValueOnce(new Error("v5 store failed")); // v5 store error

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: {
                sushiArb: "0xv4sushiArb",
                genericArb: "0xv4genericArb",
                balancerArb: "0xv4balancerArb",
                stabullArb: "0xv4stabullArb",
                dispair: {
                    deployer: "0xv4dispair",
                    interpreter: "0xv4interpreter",
                    store: "0xv4store",
                },
            },
            v5: undefined,
            getAddressesForTrade: expect.any(Function),
        });
    });

    it("should handle missing optional arb contracts", async () => {
        // Remove optional arb contracts
        mockAppOptions.contracts.v4 = {
            dispair: "0xv4dispair" as `0x${string}`,
            // No arb contracts
        };
        mockAppOptions.contracts.v5 = {
            dispair: "0xv5dispair" as `0x${string}`,
            sushiArb: "0xv5sushiArb" as `0x${string}`,
            // Missing genericArb and balancerArb
        };

        mockClient.readContract
            .mockResolvedValueOnce("0xv4interpreter" as `0x${string}`)
            .mockResolvedValueOnce("0xv4store" as `0x${string}`)
            .mockResolvedValueOnce("0xv5interpreter" as `0x${string}`)
            .mockResolvedValueOnce("0xv5store" as `0x${string}`);

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: {
                dispair: {
                    deployer: "0xv4dispair",
                    interpreter: "0xv4interpreter",
                    store: "0xv4store",
                },
                // No arb contracts should be present
            },
            v5: {
                sushiArb: "0xv5sushiArb",
                dispair: {
                    deployer: "0xv5dispair",
                    interpreter: "0xv5interpreter",
                    store: "0xv5store",
                },
                // genericArb and balancerArb should not be present
            },
            getAddressesForTrade: expect.any(Function),
        });

        // Verify no undefined properties are set
        expect(result.v4).not.toHaveProperty("sushiArb");
        expect(result.v4).not.toHaveProperty("genericArb");
        expect(result.v4).not.toHaveProperty("balancerArb");
        expect(result.v5).not.toHaveProperty("genericArb");
        expect(result.v5).not.toHaveProperty("balancerArb");
    });

    it("should return undefined for version when interpreter fetch fails", async () => {
        mockClient.readContract
            .mockResolvedValueOnce("0xv4interpreter" as `0x${string}`) // v4 interpreter success
            .mockRejectedValueOnce(new Error("v4 store failed")) // v4 store error
            .mockRejectedValueOnce(new Error("v5 interpreter failed")) // v5 interpreter error
            .mockResolvedValueOnce("0xv5store" as `0x${string}`); // v5 store success

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: undefined, // Should be undefined because store fetch failed
            v5: undefined, // Should be undefined because interpreter fetch failed
            getAddressesForTrade: expect.any(Function),
        });
    });

    it("should return undefined for version when store fetch fails", async () => {
        mockClient.readContract
            .mockRejectedValueOnce(new Error("v4 interpreter failed")) // v4 interpreter error
            .mockResolvedValueOnce("0xv5interpreter" as `0x${string}`) // v5 interpreter success
            .mockRejectedValueOnce(new Error("v5 store failed")); // v5 store error

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: undefined, // Should be undefined because interpreter fetch failed
            v5: undefined, // Should be undefined because store fetch failed
            getAddressesForTrade: expect.any(Function),
        });
    });

    it("should handle empty contracts configuration", async () => {
        mockAppOptions.contracts = {} as any;

        const result = await SolverContracts.fromAppOptions(mockClient, mockAppOptions);

        expect(result).toEqual({
            v4: undefined,
            v5: undefined,
            getAddressesForTrade: expect.any(Function),
        });

        expect(mockClient.readContract).not.toHaveBeenCalled();
    });
});

describe("resolveVersionContracts", () => {
    let mockClient: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create mock client
        mockClient = {
            readContract: vi.fn(),
        };
    });

    it("should resolve version contracts with all addresses when all contract calls succeed", async () => {
        const mockAddresses = {
            dispair: "0xdispairAddress" as `0x${string}`,
            sushiArb: "0xsushiArbAddress" as `0x${string}`,
            genericArb: "0xgenericArbAddress" as `0x${string}`,
            balancerArb: "0xbalancerArbAddress" as `0x${string}`,
            stabullArb: "0xstabullArbAddress" as `0x${string}`,
        };

        // Mock successful contract calls
        mockClient.readContract
            .mockResolvedValueOnce("0xinterpreterAddress" as `0x${string}`) // iInterpreter
            .mockResolvedValueOnce("0xstoreAddress" as `0x${string}`); // iStore

        const result = await resolveVersionContracts(mockClient, mockAddresses);

        expect(result).toEqual({
            dispair: {
                deployer: "0xdispairAddress",
                interpreter: "0xinterpreterAddress",
                store: "0xstoreAddress",
            },
            sushiArb: "0xsushiArbAddress",
            genericArb: "0xgenericArbAddress",
            balancerArb: "0xbalancerArbAddress",
            stabullArb: "0xstabullArbAddress",
        });

        expect(mockClient.readContract).toHaveBeenCalledTimes(2);
        expect(mockClient.readContract).toHaveBeenNthCalledWith(1, {
            address: "0xdispairAddress",
            functionName: "iInterpreter",
            abi: ABI.Deployer.Primary.Deployer,
        });
        expect(mockClient.readContract).toHaveBeenNthCalledWith(2, {
            address: "0xdispairAddress",
            functionName: "iStore",
            abi: ABI.Deployer.Primary.Deployer,
        });
    });

    it("should resolve version contracts with only dispair when no arb addresses are provided", async () => {
        const mockAddresses = {
            dispair: "0xdispairOnly" as `0x${string}`,
            // No arb addresses
        };

        mockClient.readContract
            .mockResolvedValueOnce("0xinterpreterOnly" as `0x${string}`)
            .mockResolvedValueOnce("0xstoreOnly" as `0x${string}`);

        const result = await resolveVersionContracts(mockClient, mockAddresses);

        expect(result).toEqual({
            dispair: {
                deployer: "0xdispairOnly",
                interpreter: "0xinterpreterOnly",
                store: "0xstoreOnly",
            },
        });

        // Should not have arb contract properties
        expect(result).not.toHaveProperty("sushiArb");
        expect(result).not.toHaveProperty("genericArb");
        expect(result).not.toHaveProperty("balancerArb");
    });

    it("should resolve version contracts with partial arb addresses", async () => {
        const mockAddresses = {
            dispair: "0xdispairPartial" as `0x${string}`,
            sushiArb: "0xsushiArbPartial" as `0x${string}`,
            // Missing genericArb and balancerArb
        };

        mockClient.readContract
            .mockResolvedValueOnce("0xinterpreterPartial" as `0x${string}`)
            .mockResolvedValueOnce("0xstorePartial" as `0x${string}`);

        const result = await resolveVersionContracts(mockClient, mockAddresses);

        expect(result).toEqual({
            dispair: {
                deployer: "0xdispairPartial",
                interpreter: "0xinterpreterPartial",
                store: "0xstorePartial",
            },
            sushiArb: "0xsushiArbPartial",
        });

        expect(result).not.toHaveProperty("genericArb");
        expect(result).not.toHaveProperty("balancerArb");
    });

    it("should return undefined when addresses parameter is undefined", async () => {
        const result = await resolveVersionContracts(mockClient, undefined);

        expect(result).toBeUndefined();
        expect(mockClient.readContract).not.toHaveBeenCalled();
    });

    it("should return undefined when dispair address is missing", async () => {
        const mockAddresses = {
            sushiArb: "0xsushiArbAddress" as `0x${string}`,
            genericArb: "0xgenericArbAddress" as `0x${string}`,
            // Missing dispair
        } as any;

        const result = await resolveVersionContracts(mockClient, mockAddresses);

        expect(result).toBeUndefined();
        expect(mockClient.readContract).not.toHaveBeenCalled();
    });

    it("should return undefined when interpreter contract call fails", async () => {
        const mockAddresses = {
            dispair: "0xdispairFailed" as `0x${string}`,
            sushiArb: "0xsushiArbAddress" as `0x${string}`,
        };

        // Mock interpreter call to fail
        mockClient.readContract.mockRejectedValueOnce(new Error("Interpreter call failed"));

        const result = await resolveVersionContracts(mockClient, mockAddresses);

        expect(result).toBeUndefined();
        expect(mockClient.readContract).toHaveBeenCalledTimes(1);
        expect(mockClient.readContract).toHaveBeenCalledWith({
            address: "0xdispairFailed",
            functionName: "iInterpreter",
            abi: ABI.Deployer.Primary.Deployer,
        });
    });

    it("should return undefined when store contract call fails", async () => {
        const mockAddresses = {
            dispair: "0xdispairStoreFailed" as `0x${string}`,
            balancerArb: "0xbalancerArbAddress" as `0x${string}`,
        };

        // Mock interpreter to succeed but store to fail
        mockClient.readContract
            .mockResolvedValueOnce("0xinterpreterSuccess" as `0x${string}`)
            .mockRejectedValueOnce(new Error("Store call failed"));

        const result = await resolveVersionContracts(mockClient, mockAddresses);

        expect(result).toBeUndefined();
        expect(mockClient.readContract).toHaveBeenCalledTimes(2);
        expect(mockClient.readContract).toHaveBeenNthCalledWith(2, {
            address: "0xdispairStoreFailed",
            functionName: "iStore",
            abi: ABI.Deployer.Primary.Deployer,
        });
    });
});

describe("versionAddressGetter", () => {
    let mockContracts: any;
    let mockOrder: Pair;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create mock contracts with all arb addresses
        mockContracts = {
            dispair: {
                deployer: "0xdispairAddress" as `0x${string}`,
                interpreter: "0xinterpreterAddress" as `0x${string}`,
                store: "0xstoreAddress" as `0x${string}`,
            },
            sushiArb: "0xsushiArbAddress" as `0x${string}`,
            genericArb: "0xgenericArbAddress" as `0x${string}`,
            balancerArb: "0xbalancerArbAddress" as `0x${string}`,
            stabullArb: "0xstabullArbAddress" as `0x${string}`,
        };

        // Create mock order
        mockOrder = {
            orderbook: "0xorderbookAddress" as `0x${string}`,
            id: "order123",
        } as any as Pair;
    });

    it("should return dispair and empty destination when no tradeType is provided", () => {
        const result = versionAddressGetter(mockContracts, mockOrder);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0x",
        });
    });

    it("should return sushiArb for Router tradeType when sushiArb is available", () => {
        const result = versionAddressGetter(mockContracts, mockOrder, TradeType.Router);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xsushiArbAddress",
        });
    });

    it("should return balancerArb for Router tradeType when sushiArb is not available", () => {
        // Remove sushiArb
        const contractsWithoutSushi = {
            ...mockContracts,
            sushiArb: undefined,
        };

        const result = versionAddressGetter(contractsWithoutSushi, mockOrder, TradeType.Router);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xbalancerArbAddress",
        });
    });

    it("should return undefined for Router tradeType when no arb contracts are available", () => {
        const contractsWithoutArbs = {
            dispair: mockContracts.dispair,
            // No arb contracts
        };

        const result = versionAddressGetter(contractsWithoutArbs, mockOrder, TradeType.Router);

        expect(result).toBeUndefined();
    });

    it("should return sushiArb for RouteProcessor tradeType when available", () => {
        const result = versionAddressGetter(mockContracts, mockOrder, TradeType.RouteProcessor);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xsushiArbAddress",
        });
    });

    it("should return undefined for RouteProcessor tradeType when sushiArb is not available", () => {
        const contractsWithoutSushi = {
            ...mockContracts,
            sushiArb: undefined,
        };

        const result = versionAddressGetter(
            contractsWithoutSushi,
            mockOrder,
            TradeType.RouteProcessor,
        );

        expect(result).toBeUndefined();
    });

    it("should return balancerArb for Balancer tradeType when available", () => {
        const result = versionAddressGetter(mockContracts, mockOrder, TradeType.Balancer);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xbalancerArbAddress",
        });
    });

    it("should return undefined for Balancer tradeType when balancerArb is not available", () => {
        const contractsWithoutBalancer = {
            ...mockContracts,
            balancerArb: undefined,
        };

        const result = versionAddressGetter(
            contractsWithoutBalancer,
            mockOrder,
            TradeType.Balancer,
        );

        expect(result).toBeUndefined();
    });

    it("should return stabullArb for Stabull tradeType when available", () => {
        const result = versionAddressGetter(mockContracts, mockOrder, TradeType.Stabull);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xstabullArbAddress",
        });
    });

    it("should return undefined for Stabull tradeType when stabullArb is not available", () => {
        const contractsWithoutStabull = {
            ...mockContracts,
            stabullArb: undefined,
        };

        const result = versionAddressGetter(contractsWithoutStabull, mockOrder, TradeType.Stabull);

        expect(result).toBeUndefined();
    });

    it("should return stabullArb for Router tradeType when sushiArb and balancerArb are not available", () => {
        const contractsOnlyStabull = {
            ...mockContracts,
            sushiArb: undefined,
            balancerArb: undefined,
        };
        const result = versionAddressGetter(contractsOnlyStabull, mockOrder, TradeType.Router);
        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xstabullArbAddress",
        });
    });

    it("should return genericArb for InterOrderbook tradeType when available", () => {
        const result = versionAddressGetter(mockContracts, mockOrder, TradeType.InterOrderbook);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xgenericArbAddress",
        });
    });

    it("should return undefined for InterOrderbook tradeType when genericArb is not available", () => {
        const contractsWithoutGeneric = {
            ...mockContracts,
            genericArb: undefined,
        };

        const result = versionAddressGetter(
            contractsWithoutGeneric,
            mockOrder,
            TradeType.InterOrderbook,
        );

        expect(result).toBeUndefined();
    });

    it("should return orderbook address for IntraOrderbook tradeType", () => {
        const result = versionAddressGetter(mockContracts, mockOrder, TradeType.IntraOrderbook);

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xorderbookAddress",
        });
    });

    it("should return orderbook address for IntraOrderbook even when no arb contracts exist", () => {
        const contractsWithoutArbs = {
            dispair: mockContracts.dispair,
            // No arb contracts
        };

        const result = versionAddressGetter(
            contractsWithoutArbs,
            mockOrder,
            TradeType.IntraOrderbook,
        );

        expect(result).toEqual({
            dispair: mockContracts.dispair,
            destination: "0xorderbookAddress",
        });
    });
});
