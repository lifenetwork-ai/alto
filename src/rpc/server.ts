import {
    type ApiVersion,
    ERC7769Errors,
    type JSONRPCResponse,
    RpcError,
    altoVersions,
    bundlerRequestSchema,
    jsonRpcSchema
} from "@alto/types"
import type { Metrics } from "@alto/utils"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import * as sentry from "@sentry/node"
import Fastify, {
    type FastifyBaseLogger,
    type FastifyInstance,
    type FastifyReply,
    type FastifyRequest
} from "fastify"
import type { Registry } from "prom-client"
import { toHex } from "viem"
import type * as WebSocket from "ws"
import { fromZodError } from "zod-validation-error"
import type { AltoConfig } from "../createConfig"
import rpcDecorators, { RpcStatus } from "../utils/fastify-rpc-decorators"
import RpcReply from "../utils/rpc-reply"
import type { RpcHandler } from "./rpcHandler"

// jsonBigIntOverride.ts
const originalJsonStringify = JSON.stringify

JSON.stringify = (
    // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
    value: any,
    replacer?: // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
    ((this: any, key: string, value: any) => any) | (string | number)[] | null,
    space?: string | number
): string => {
    // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
    const bigintReplacer = (_key: string, value: any): any => {
        if (typeof value === "bigint") {
            return toHex(value)
        }
        return value
    }

    // biome-ignore lint/suspicious/noExplicitAny: it's a generic type
    const wrapperReplacer = (key: string, value: any): any => {
        if (typeof replacer === "function") {
            // biome-ignore lint: no other way to do this
            value = replacer(key, value)
        } else if (Array.isArray(replacer)) {
            if (!replacer.includes(key)) {
                return
            }
        }
        return bigintReplacer(key, value)
    }

    return originalJsonStringify(value, wrapperReplacer, space)
}

type RpcExecutionResult = {
    body: unknown
    httpStatus: number
    rpcStatus: RpcStatus
}

const mergeBatchRpcStatus = (responses: RpcExecutionResult[]): RpcStatus => {
    if (
        responses.some(
            (response) => response.rpcStatus === RpcStatus.ServerError
        )
    ) {
        return RpcStatus.ServerError
    }
    if (
        responses.some(
            (response) => response.rpcStatus === RpcStatus.ClientError
        )
    ) {
        return RpcStatus.ClientError
    }
    return RpcStatus.Success
}

export class Server {
    private readonly config: AltoConfig
    private readonly fastify: FastifyInstance
    private readonly rpcEndpoint: RpcHandler
    private readonly registry: Registry
    private readonly metrics: Metrics

    constructor({
        config,
        rpcEndpoint,
        registry,
        metrics
    }: {
        config: AltoConfig
        rpcEndpoint: RpcHandler
        registry: Registry
        metrics: Metrics
    }) {
        this.config = config
        const logger = config.getLogger(
            { module: "rpc" },
            {
                level: config.rpcLogLevel || config.logLevel
            }
        )

        this.fastify = Fastify({
            logger: logger as FastifyBaseLogger, // workaround for https://github.com/fastify/fastify/issues/4960
            requestTimeout: config.timeout,
            disableRequestLogging: true
        })
        if (config.enableCors) {
            this.fastify.register(cors, {
                origin: "*",
                methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
            })
        }

        this.fastify.register(rpcDecorators)

        this.fastify.register(websocket, {
            options: {
                maxPayload: config.websocketMaxPayloadSize
            }
        })

        this.fastify.addHook("onResponse", (request, reply) => {
            const ignoredRoutes = ["/health", "/metrics"]
            if (ignoredRoutes.includes(request.routeOptions.url)) {
                return
            }

            const labels = {
                route: request.routeOptions.url,
                code: reply.statusCode,
                method: request.method,
                rpc_method: request.rpcMethod,
                rpc_status: reply.rpcStatus
            }

            this.metrics.httpRequests.labels(labels).inc()

            const durationMs = reply.elapsedTime
            const durationSeconds = durationMs / 1000
            this.metrics.httpRequestsDuration
                .labels(labels)
                .observe(durationSeconds)
        })

        this.fastify.post("/rpc", this.rpcHttp.bind(this))
        this.fastify.post("/:version/rpc", this.rpcHttp.bind(this))
        this.fastify.post("/", this.rpcHttp.bind(this))

        if (config.websocket) {
            this.fastify.register((fastify) => {
                fastify.route({
                    method: "GET",
                    url: "/:version/rpc",
                    handler: async (request, reply) => {
                        const version = (request.params as any).version

                        await reply
                            .status(404)
                            .send(
                                `GET request to /${version}/rpc is not supported, use POST isntead`
                            )
                    },
                    wsHandler: (socket: WebSocket.WebSocket, request) => {
                        socket.on("message", async (msgBuffer: Buffer) =>
                            this.rpcSocket(request, msgBuffer, socket)
                        )
                    }
                })
            })
        }

        this.fastify.get("/health", this.healthCheck.bind(this))
        this.fastify.get("/metrics", this.serveMetrics.bind(this))

        this.rpcEndpoint = rpcEndpoint
        this.registry = registry
        this.metrics = metrics
    }

    public start(): void {
        this.fastify.listen({ port: this.config.port, host: "0.0.0.0" })
    }

    public async stop(): Promise<void> {
        await this.fastify.close()
    }

    public async healthCheck(
        _request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        await reply.status(200).send("OK")
    }

    private async rpcSocket(
        request: FastifyRequest,
        msgBuffer: Buffer,
        socket: WebSocket.WebSocket
    ): Promise<void> {
        try {
            request.body = JSON.parse(msgBuffer.toString())
        } catch {
            socket.send(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: null,
                    error: {
                        message: "invalid JSON-RPC request",
                        data: msgBuffer.toString(),
                        code: ERC7769Errors.InvalidFields
                    }
                })
            )
            return
        }

        await this.rpc(request, RpcReply.fromSocket(socket))
    }

    private async rpcHttp(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        await this.rpc(request, RpcReply.fromHttpReply(reply))
    }

    private async rpc(request: FastifyRequest, reply: RpcReply): Promise<void> {
        const versionParsingResult = altoVersions.safeParse(
            (request.params as any)?.version ?? this.config.defaultApiVersion
        )

        if (!versionParsingResult.success) {
            const error = fromZodError(versionParsingResult.error)
            throw new RpcError(
                `invalid version ${error.message}`,
                ERC7769Errors.InvalidFields
            )
        }

        const apiVersion: ApiVersion = versionParsingResult.data

        if (!this.config.apiVersion.includes(apiVersion)) {
            throw new RpcError(
                `unsupported version ${apiVersion}`,
                ERC7769Errors.InvalidFields
            )
        }

        try {
            const contentTypeHeader = request.headers["content-type"]

            // Common browser websocket API does not allow setting custom headers
            if (
                contentTypeHeader !== "application/json" &&
                request.ws === false
            ) {
                throw new RpcError(
                    "invalid content-type, content-type must be application/json",
                    ERC7769Errors.InvalidFields
                )
            }
            this.fastify.log.trace(
                { body: JSON.stringify(request.body) },
                "received request"
            )

            if (Array.isArray(request.body)) {
                await this.rpcBatch(request, reply, request.body, apiVersion)
                return
            }

            const response = await this.rpcSingle(
                request,
                request.body,
                apiVersion
            )
            await reply
                .setRpcStatus(response.rpcStatus)
                .status(response.httpStatus)
                .send(response.body)
        } catch (err) {
            const requestId: number | null = null
            if (err instanceof RpcError) {
                const rpcError = {
                    jsonrpc: "2.0",
                    id: requestId,
                    error: {
                        message: err.message,
                        data: err.data,
                        code: err.code
                    }
                }
                await reply
                    .setRpcStatus(RpcStatus.ClientError)
                    .status(200)
                    .send(rpcError)
                this.fastify.log.info(rpcError, "error reply")
            } else if (err instanceof Error) {
                sentry.captureException(err)
                const rpcError = {
                    jsonrpc: "2.0",
                    id: requestId,
                    error: {
                        message: err.message
                    }
                }

                await reply
                    .setRpcStatus(RpcStatus.ServerError)
                    .status(500)
                    .send(rpcError)
                this.fastify.log.error(err, "error reply (non-rpc)")
            } else {
                const rpcError = {
                    jsonrpc: "2.0",
                    id: requestId,
                    error: {
                        message: "Unknown error"
                    }
                }

                await reply
                    .setRpcStatus(RpcStatus.ServerError)
                    .status(500)
                    .send(rpcError)
                this.fastify.log.error(
                    { err },
                    "error reply (unhandled error type)"
                )
            }
        }
    }

    private async rpcBatch(
        request: FastifyRequest,
        reply: RpcReply,
        batch: unknown[],
        apiVersion: ApiVersion
    ): Promise<void> {
        request.rpcMethod = "batch"
        if (batch.length === 0) {
            const response = this.rpcErrorResponse(
                new RpcError(
                    "invalid JSON-RPC batch request",
                    ERC7769Errors.InvalidFields
                ),
                null
            )
            await reply
                .setRpcStatus(RpcStatus.ClientError)
                .status(200)
                .send(response.body)
            this.fastify.log.info(response.body, "error reply")
            return
        }

        const responses = await Promise.all(
            batch.map((payload) =>
                this.rpcSingle(request, payload, apiVersion, false)
            )
        )
        const rpcStatus = mergeBatchRpcStatus(responses)
        await reply
            .setRpcStatus(rpcStatus)
            .status(200)
            .send(responses.map((response) => response.body))
    }

    private async rpcSingle(
        request: FastifyRequest,
        payload: unknown,
        apiVersion: ApiVersion,
        recordRequestMethod = true
    ): Promise<RpcExecutionResult> {
        let requestId: number | null = null

        try {
            const jsonRpcParsing = jsonRpcSchema.safeParse(payload)
            if (!jsonRpcParsing.success) {
                const validationError = fromZodError(jsonRpcParsing.error)
                throw new RpcError(
                    `invalid JSON-RPC request ${validationError.message}`,
                    ERC7769Errors.InvalidFields
                )
            }

            const jsonRpcRequest = jsonRpcParsing.data
            requestId = jsonRpcRequest.id

            const bundlerRequestParsing =
                bundlerRequestSchema.safeParse(jsonRpcRequest)
            if (!bundlerRequestParsing.success) {
                const validationError = fromZodError(
                    bundlerRequestParsing.error
                )

                if (
                    validationError.message.includes(
                        "Missing/invalid userOpHash"
                    )
                ) {
                    throw new RpcError(
                        "Missing/invalid userOpHash",
                        ERC7769Errors.InvalidFields
                    )
                }

                throw new RpcError(
                    validationError.message,
                    ERC7769Errors.InvalidRequest
                )
            }

            const bundlerRequest = bundlerRequestParsing.data
            if (recordRequestMethod) {
                request.rpcMethod = bundlerRequest.method
            }

            if (
                this.config.rpcMethods !== null &&
                !this.config.rpcMethods.includes(bundlerRequest.method)
            ) {
                throw new RpcError(
                    `Method not supported: ${bundlerRequest.method}`,
                    ERC7769Errors.InvalidRequest
                )
            }

            this.fastify.log.info(
                {
                    data: JSON.stringify(bundlerRequest, null),
                    method: bundlerRequest.method
                },
                "incoming request"
            )
            const result = await this.rpcEndpoint.handleMethod(
                bundlerRequest,
                apiVersion
            )
            const jsonRpcResponse: JSONRPCResponse = {
                jsonrpc: "2.0",
                id: jsonRpcRequest.id,
                result
            }

            this.logRpcResponse(bundlerRequest.method, jsonRpcResponse)
            return {
                body: jsonRpcResponse,
                httpStatus: 200,
                rpcStatus: RpcStatus.Success
            }
        } catch (err) {
            if (err instanceof RpcError) {
                const response = this.rpcErrorResponse(err, requestId)
                this.fastify.log.info(response.body, "error reply")
                return response
            }

            if (err instanceof Error) {
                sentry.captureException(err)
                const response = {
                    body: {
                        jsonrpc: "2.0",
                        id: requestId,
                        error: {
                            message: err.message
                        }
                    },
                    httpStatus: 500,
                    rpcStatus: RpcStatus.ServerError
                }
                this.fastify.log.error(err, "error reply (non-rpc)")
                return response
            }

            const response = {
                body: {
                    jsonrpc: "2.0",
                    id: requestId,
                    error: {
                        message: "Unknown error"
                    }
                },
                httpStatus: 500,
                rpcStatus: RpcStatus.ServerError
            }
            this.fastify.log.error(
                { err },
                "error reply (unhandled error type)"
            )
            return response
        }
    }

    private rpcErrorResponse(
        err: RpcError,
        requestId: number | null
    ): RpcExecutionResult {
        return {
            body: {
                jsonrpc: "2.0",
                id: requestId,
                error: {
                    message: err.message,
                    data: err.data,
                    code: err.code
                }
            },
            httpStatus: 200,
            rpcStatus: RpcStatus.ClientError
        }
    }

    private logRpcResponse(method: string, response: JSONRPCResponse): void {
        this.fastify.log.info(
            {
                data:
                    method === "eth_getUserOperationReceipt" && response.result
                        ? {
                              ...response,
                              result: "<reduced>"
                          }
                        : response, // do not log the full result for eth_getUserOperationReceipt to reduce log size
                method
            },
            "sent reply"
        )
    }

    public async serveMetrics(
        _request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        reply.headers({ "Content-Type": this.registry.contentType })
        const metrics = await this.registry.metrics()
        await reply.send(metrics)
    }
}
