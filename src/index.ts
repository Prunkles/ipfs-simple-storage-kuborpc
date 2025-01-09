import * as fs from "node:fs";
import express from "express"
import expressBasicAuth from "express-basic-auth";
import logger from "morgan"
import multer from "multer";
import * as kuboRpcClient from "kubo-rpc-client"
import {CID, IPFSPath, KuboRPCClient} from "kubo-rpc-client";
import {Ok, Err, Result} from "ts-results-es";


const configPath = process.env.CONFIG ?? "./config.json"
const config = JSON.parse(fs.readFileSync(configPath).toString())
const basicAuthUsers = config.basicAuthUsers
const ipfsMfsRoot = config.ipfsMfsRoot
const kuboClientConfig = config.kuboClient

const kuboClient = kuboRpcClient.create({
    url: kuboClientConfig.url,
    headers: kuboClientConfig.headers,
})


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
            const buffer = req.file.buffer
            const addRes = await kuboClient.add(buffer, {
                cidVersion: 1,
                chunker: "size-1048576",
            })
            const cid = addRes.cid
            if (await ipfsFilesExists(kuboClient, getFilePathFromRoot(ipfsMfsRoot, cid))) {
                return res.status(409).contentType('application/problem+json').json({
                    type: '/content-already-exists',
                    title: 'Content already exists',
                    details: `Content ${cid.toString()} already exists`,
                    cid: cid.toString(),
                })
            }

            await kuboClient.files.cp(cid, getFilePathFromRoot(ipfsMfsRoot, cid))
            const mfsRootStatRes = await kuboClient.files.stat(ipfsMfsRoot)
            res.status(200)
            res.contentType("application/json")
            res.send(JSON.stringify({
                cid: cid,
                newRootCid: mfsRootStatRes.cid,
            }))
        } catch (error) {
            console.error(error)
            res.status(500)
            res.send(error.toString())
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
            const cidStr = req.params.cid.toString()
            const cidRes = tryParseCID(cidStr)
            if (cidRes.isErr()) {
                res.status(400)
                res.send(`'${cidStr}' is not a CID: ${cidRes.error}`)
                return
            }
            const cid = cidRes.value
            const exists = await ipfsFilesExists(kuboClient, getFilePathFromRoot(ipfsMfsRoot, cid))
            if (!exists) {
                res.status(404).contentType('application/problem+json').json({
                    type: '/content-not-found',
                    title: 'Content not found',
                    details: `Content ${cid.toString()} not found`,
                    cid: cid.toString(),
                })
                return
            }
            await kuboClient.pin.rm(cid)
            await kuboClient.files.rm(getFilePathFromRoot(ipfsMfsRoot, cid))
            const mfsRootStatRes = await kuboClient.files.stat(ipfsMfsRoot)
            res.status(200)
            res.contentType("application/json")
            res.send(JSON.stringify({
                newRootCid: mfsRootStatRes.cid,
            }))
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
            const rootCid = (await kuboClient.files.stat(ipfsMfsRoot)).cid
            const cids: CID[] = []
            for await (const entry of kuboClient.files.ls(`${ipfsMfsRoot}`)) {
                cids.push(entry.cid)
            }
            res.status(200).json({
                rootCid,
                cids,
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

