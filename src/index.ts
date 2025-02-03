import * as fs from "node:fs";
import type { Request as ExpressRequest } from "express"
import express from "express"
import expressBasicAuth from "express-basic-auth";
import morgan from "morgan"
import multer from "multer";
import * as kuboRpcClient from "kubo-rpc-client"
import {CID, IPFSPath, KuboRPCClient} from "kubo-rpc-client";
import {Ok, Err, Result} from "ts-results-es";
import { v4 as uuidv4 } from "uuid";
import { Mutex } from 'async-mutex'


const configPath = process.env.CONFIG ?? "./config.json"
const config = JSON.parse(fs.readFileSync(configPath).toString())
const basicAuthUsers = config.basicAuthUsers
const ipfsMfsRoot = config.ipfsMfsRoot
const kuboClientConfig = config.kuboClient

const kuboClient = kuboRpcClient.create({
    url: kuboClientConfig.url,
    headers: kuboClientConfig.headers,
})

const mutex = new Mutex()

const app = express()
const upload = multer()

app.use((req, res, next) => {
    (req as any).requestId = uuidv4()
    next()
})
morgan.token('requestId', req => (req as any).requestId)
app.use(morgan('--> :requestId ":method :url HTTP/:http-version"', {immediate: true}))
app.use(morgan('<-- :requestId ":method :url HTTP/:http-version" :status :res[content-length] - :response-time ms', {immediate: false}))

app.use(express.json())
app.use(express.urlencoded({ extended: false }))

function createExpressRequestAbortSignal(req: ExpressRequest) {
    const abortController = new AbortController()
    req.socket.on('close', () => {
        const requestId = (req as any).requestId
        abortController.abort(new Error(`Request ${requestId} aborted`))
    })
    return abortController.signal
}

function getFilePathFromRoot(ipfsMfsRoot: string, cid: CID): string {
    return `${ipfsMfsRoot}/${cid.toString()}`
}

async function ipfsFilesExists(kuboClient: KuboRPCClient, ipfsPath: IPFSPath, abortSignal?: AbortSignal) {
    try {
        await kuboClient.files.stat(ipfsPath, { signal: abortSignal })
        return true
    } catch (err) {
        if (err.message === "file does not exist") {
            return false
        } else {
            throw err
        }
    }
}

app.post('/add',
    expressBasicAuth({ users: basicAuthUsers }),
    upload.single("file"),
    async (req, res) => {
        try {
            const abortSignal = createExpressRequestAbortSignal(req)
            await mutex.runExclusive(async () => {
                abortSignal.throwIfAborted()

                const buffer = req.file.buffer
                console.log(`Adding an object content`)
                const addRes = await kuboClient.add(buffer, {
                    pin: false,
                    signal: abortSignal,
                })
                const cid = addRes.cid
                console.log(`Added object content ${addRes.cid.toString()}`)
                // FIXME: Possible GC before copied to MFS

                const filePath = getFilePathFromRoot(ipfsMfsRoot, cid)
                if (await ipfsFilesExists(kuboClient, filePath, abortSignal)) {
                    console.log(`Path ${filePath} already exists`)
                    return res.status(409).contentType('application/problem+json').json({
                        type: '/problems/object-content-already-exists',
                        title: 'Object content already exists',
                        details: `Object content ${cid} already exists`,
                        cid: cid.toString(),
                    })
                }

                console.log(`Copying content ${cid} to path ${filePath}`)
                await kuboClient.files.cp(cid, filePath, { signal: abortSignal })
                console.log(`Copied content ${cid} to path ${filePath}`)

                const mfsRootStatRes = await kuboClient.files.stat(ipfsMfsRoot, { signal: abortSignal })
                console.log(`New root is ${mfsRootStatRes.cid.toString()}`)
                res.status(200).json({
                    objectCid: cid,
                    newBucketRootCid: mfsRootStatRes.cid,
                })
            })
        } catch (error) {
            console.error(error)
            res.status(500).send(error.toString())
        }
    }
)

function tryParseCID(input: string): Result<CID, Error> {
    try {
        return new Ok(CID.parse(input))
    } catch (err) {
        return new Err(err)
    }
}

app.post('/remove/:cid',
    expressBasicAuth({ users: basicAuthUsers }),
    async (req, res) => {
        try {
            const abortSignal = createExpressRequestAbortSignal(req)
            await mutex.runExclusive(async () => {
                abortSignal.throwIfAborted()

                const cidStr = req.params.cid.toString()
                const cidRes = tryParseCID(cidStr)
                if (cidRes.isErr()) {
                    res.status(400).contentType('application/problem+json').json({
                        type: '/problems/invalid-cid',
                        error: cidRes.error,
                    })
                    return
                }
                const cid = cidRes.value
                console.log(`Removing ${cid.toString()}`)

                const exists = await ipfsFilesExists(kuboClient, getFilePathFromRoot(ipfsMfsRoot, cid), abortSignal)
                if (!exists) {
                    console.log(`${cid.toString()} not found`)
                    res.status(404).contentType('application/problem+json').json({
                        type: '/problems/object-not-found',
                        title: 'Object not found',
                        details: `Object ${cid.toString()} not found`,
                        cid: cid.toString(),
                    })
                    return
                }

                const filePath = getFilePathFromRoot(ipfsMfsRoot, cid)
                console.log(`Removing file ${filePath}`)
                await kuboClient.files.rm(filePath, { signal: abortSignal })

                const mfsRootStatRes = await kuboClient.files.stat(ipfsMfsRoot, { signal: abortSignal })
                console.log(`New root is ${mfsRootStatRes.cid.toString()}`)
                res.status(200).json({
                    newBucketRootCid: mfsRootStatRes.cid,
                })
            })
        } catch (error) {
            console.error(error)
            res.status(500).send(error.toString())
        }
    }
)

app.get('/list',
    expressBasicAuth({ users: basicAuthUsers }),
    async (req, res) => {
        try {
            const abortSignal = createExpressRequestAbortSignal(req)
            await mutex.runExclusive(async () => {
                abortSignal.throwIfAborted()

                console.log('Listing all objects')
                const bucketRootCid = (await kuboClient.files.stat(ipfsMfsRoot, { signal: abortSignal })).cid
                console.log(`Bucket root cid is ${bucketRootCid}`)
                const objectCids: CID[] = []
                for await (const entry of kuboClient.ls(bucketRootCid, { signal: abortSignal })) {
                    objectCids.push(entry.cid)
                }
                console.log(`Listed ${objectCids.length} objects`)
                res.status(200).json({
                    bucketRootCid,
                    objectCids,
                })
            })
        } catch (error) {
            console.error(error)
            res.status(500).send(error.toString())
        }
    }
)

app.get('/healthz',
    expressBasicAuth({ users: basicAuthUsers }),
    async (req, res) => {
        try {
            const abortSignal = createExpressRequestAbortSignal(req)
            await mutex.runExclusive(async () => {
                abortSignal.throwIfAborted()
                res.send('OK')
            })
        } catch (error) {
            console.error(error)
            res.status(500).send(error.toString())
        }
    }
)

const port = parseInt(process.env.PORT ?? '8080')
const address = process.env.ADDRESS ?? '0.0.0.0'
const server = app.listen(port, address, () => {
    console.log(`Listening on ${address}:${port}`)
})

// https://emmer.dev/blog/you-don-t-need-an-init-system-for-node.js-in-docker/
const shutdown = () => {
    console.log("Stopping...")
    server.close(() => {
        console.log("Stopped")
    })
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

