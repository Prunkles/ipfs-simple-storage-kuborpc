import * as fs from "node:fs";
import express from "express"
import expressBasicAuth from "express-basic-auth";
import logger from "morgan"
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

app.use(logger('dev'))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

function getFilePathFromRoot(ipfsMfsRoot: string, cid: CID): string {
    return `${ipfsMfsRoot}/${cid.toString()}`
}

async function ipfsFilesExists(kuboClient: KuboRPCClient, ipfsPath: IPFSPath) {
    try {
        await kuboClient.files.stat(ipfsPath)
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
            await mutex.runExclusive(async () => {
                const buffer = req.file.buffer
                const tmpFilePath = `${ipfsMfsRoot}/tmp_${uuidv4()}`
                console.log(`Adding a content to file ${tmpFilePath}`)
                const addRes = await kuboClient.add(buffer, {
                    cidVersion: 1,
                    chunker: "size-1048576",
                    pin: false,
                    ...{
                        'to-files': tmpFilePath,
                    } as any
                })
                const cid = addRes.cid
                console.log(`Added ${cid.toString()} to file ${tmpFilePath}`)

                const filePath = getFilePathFromRoot(ipfsMfsRoot, cid)
                if (await ipfsFilesExists(kuboClient, filePath)) {
                    console.log(`Path ${filePath} already exists. Removing ${tmpFilePath}`)
                    await kuboClient.files.rm(tmpFilePath)
                    return res.status(409).contentType('application/problem+json').json({
                        type: '/content-already-exists',
                        title: 'Content already exists',
                        details: `Content ${cid.toString()} already exists`,
                        cid: cid.toString(),
                    })
                }

                console.log(`Moving file ${tmpFilePath} to ${filePath}`)
                await kuboClient.files.mv(tmpFilePath, filePath)
                console.log(`Moved file ${tmpFilePath} to ${filePath}`)

                const mfsRootStatRes = await kuboClient.files.stat(ipfsMfsRoot)
                console.log(`New root is ${mfsRootStatRes.cid.toString()}`)
                res.status(200).json({
                    cid: cid,
                    newRootCid: mfsRootStatRes.cid,
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
            await mutex.runExclusive(async () => {
                const cidStr = req.params.cid.toString()
                const cidRes = tryParseCID(cidStr)
                if (cidRes.isErr()) {
                    res.status(400)
                    res.send(`'${cidStr}' is not a CID: ${cidRes.error}`)
                    return
                }
                const cid = cidRes.value
                console.log(`Removing ${cid.toString()}`)

                const exists = await ipfsFilesExists(kuboClient, getFilePathFromRoot(ipfsMfsRoot, cid))
                if (!exists) {
                    console.log(`${cid.toString()} not found`)
                    res.status(404).contentType('application/problem+json').json({
                        type: '/content-not-found',
                        title: 'Content not found',
                        details: `Content ${cid.toString()} not found`,
                        cid: cid.toString(),
                    })
                    return
                }

                const filePath = getFilePathFromRoot(ipfsMfsRoot, cid)
                console.log(`Removing file ${filePath}`)
                await kuboClient.files.rm(filePath)

                const mfsRootStatRes = await kuboClient.files.stat(ipfsMfsRoot)
                console.log(`New root is ${mfsRootStatRes.cid.toString()}`)
                res.status(200).json({
                    newRootCid: mfsRootStatRes.cid,
                })
            })
        } catch (error) {
            console.error(error)
            res.status(500)
            res.send(error.toString())
        }
    }
)

app.get('/list',
    expressBasicAuth({ users: basicAuthUsers }),
    async (req, res) => {
        try {
            await mutex.runExclusive(async () => {
                const rootCid = (await kuboClient.files.stat(ipfsMfsRoot)).cid
                const cids: CID[] = []
                for await (const entry of kuboClient.files.ls(`${ipfsMfsRoot}`)) {
                    if (!entry.name.startsWith('tmp_')) {
                        cids.push(entry.cid)
                    }
                }
                res.status(200).json({
                    rootCid,
                    cids,
                })
            })
        } catch (error) {
            console.error(error)
            res.status(500)
            res.send(error.toString())
        }
    }
)

const port = process.env.PORT ?? 8080
const server = app.listen(port, () => {
    console.log(`Listening on ${port}`)
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

