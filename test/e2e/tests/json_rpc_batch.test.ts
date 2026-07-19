import { describe, expect, inject, test } from "vitest"

describe("JSON-RPC batch requests", () => {
    const altoRpc = inject("altoRpc")

    test("supports batched user operation status lookups", async () => {
        const missingHash =
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        const response = await fetch(altoRpc, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify([
                {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_getUserOperationReceipt",
                    params: [missingHash]
                },
                {
                    jsonrpc: "2.0",
                    id: 2,
                    method: "eth_getUserOperationByHash",
                    params: [missingHash]
                }
            ])
        })

        expect(response.status).toBe(200)
        const body = await response.json()

        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(2)
        expect(body.map((item: { id: number }) => item.id)).toEqual([1, 2])
        expect(body[0]).toEqual({
            jsonrpc: "2.0",
            id: 1,
            result: null
        })
        expect(body[1]).toEqual({
            jsonrpc: "2.0",
            id: 2,
            result: null
        })
    })
})
