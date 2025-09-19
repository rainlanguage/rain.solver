const { assert } = require("chai");
const { ethers } = require("ethers");
const { clone, extendSpanAttributes, withBigintSerializer } = require("../src/utils");

describe("Test utils functions", async function () {
    it("should clone correctly", async function () {
        const obj = {
            a: 123,
            b: true,
            c: "some string",
            d: [1, 2, 3],
            e: ethers.BigNumber.from(1),
            f: {
                a: ethers.BigNumber.from(2),
                b: ["1", "2", "3"],
                c: {
                    a: true,
                    b: [ethers.BigNumber.from(1), ethers.BigNumber.from(2)],
                },
            },
        };
        const result = clone(obj);
        assert.deepEqual(result, obj);
        assert.notEqual(result, obj);
        assert.notEqual(result.f.b, obj.f.b);
        assert.notEqual(result.f.c, obj.f.c);
        assert.notEqual(result.f.c.b, obj.f.c.b);
    });

    it("should test extendSpanAttributes", async function () {
        const newAttrs = {
            a: 10,
            b: true,
            c: "some string",
        };
        const spanAttrs = {
            oldKey: "some value",
        };
        extendSpanAttributes(spanAttrs, newAttrs, "header");

        const expected = {
            oldKey: "some value",
            "header.a": 10,
            "header.b": true,
            "header.c": "some string",
        };
        assert.deepEqual(spanAttrs, expected);
    });

    it("should test withBigIntSerializer", async function () {
        // bigint
        let value = 123n;
        let result = withBigintSerializer("key", value);
        assert.equal(result, "123");

        // set
        value = new Set(["a", "b", "c"]);
        result = withBigintSerializer("key", value);
        assert.deepEqual(result, ["a", "b", "c"]);

        // set wih bigint
        value = {
            a: 123n,
            b: new Set([1n, 2n]),
        };
        result = JSON.stringify(value, withBigintSerializer);
        assert.equal(result, '{"a":"123","b":["1","2"]}');

        // else
        value = 123;
        result = withBigintSerializer("key", value);
        assert.equal(result, 123);
    });
});
