import * as fs from "node:fs";
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
                console.log(`Adding a content`)
                const addRes = await kuboClient.add(buffer, {
                    pin: false,
                })
                const cid = addRes.cid
                console.log(`Added content ${addRes.cid.toString()}`)
                // FIXME: Possible GC before copied to MFS

                const filePath = getFilePathFromRoot(ipfsMfsRoot, cid)
                if (await ipfsFilesExists(kuboClient, filePath)) {
                    console.log(`Path ${filePath} already exists`)
                    return res.status(409).contentType('application/problem+json').json({
                        type: '/content-already-exists',
                        title: 'Content already exists',
                        details: `Content ${cid} already exists`,
                        cid: cid.toString(),
                    })
                }

                console.log(`Copying content ${cid} to path ${filePath}`)
                await kuboClient.files.cp(cid, filePath)
                console.log(`Copied content ${cid} to path ${filePath}`)

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

app.get('/healthz',
    expressBasicAuth({ users: basicAuthUsers }),
    async (req, res) => {
        try {
            await mutex.runExclusive(async () => {
                res.send('OK')
            })
        } catch (error) {
            console.error(error)
            res.status(500)
            res.send(error.toString())
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

