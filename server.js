import express from 'express'
import Redis from "ioredis"
import { consistentHashRing } from './consistentHash.js'

const redisNodes = {
    NodeA: new Redis({ host: process.env.REDIS_A_HOST || 'localhost', port: 6379 }),
    NodeB: new Redis({ host: process.env.REDIS_B_HOST || 'localhost', port: process.env.REDIS_B_HOST ? 6379 : 6380 }),
    NodeC: new Redis({ host: process.env.REDIS_C_HOST || 'localhost', port: process.env.REDIS_C_HOST ? 6379 : 6381 }),
};

const app= express()

async function acquireLock(redis, lockKey, ttl = 5) {
    const result = await redis.set(lockKey, 'locked', 'NX', 'EX', ttl);
    return result === 'OK';
}

async function releaseLock(redis, lockKey) {
    await redis.del(lockKey);
}

const ring=new  consistentHashRing()
ring.addNode('NodeA')
ring.addNode('NodeB')
ring.addNode('NodeC')

app.get('/api/resource', async(req,res)=>{
    const clientId= req.headers['x-client-id'] || req.ip
    const nodeName= ring.getNode(clientId)
    console.log('DEBUG nodeName:', nodeName, typeof nodeName)
console.log('DEBUG redisNodes keys:', Object.keys(redisNodes))


    const redis= redisNodes[nodeName]
    const lockKey= `lock:${clientId}`
    const rateKey=  `ratelimit:${clientId}`

    const gotLock= await acquireLock(redis,lockKey)

    if (!gotLock) {
        return res.status(429).json({ error: 'System busy, try again shortly' });
    }

    try { 
    let requests= await redis.get(rateKey)
    requests= requests ? parseInt(requests) : 0;

    if(requests >= 5){
        return res.status(429).json({error : "too many requests", node: nodeName})
    }

    await redis.incr(rateKey)
    await redis.expire(rateKey,60)


    res.json({message : "request successful", requests: requests+1, node: nodeName })
    }
    finally{
        await releaseLock(redis,lockKey)
    }
})

app.listen(3000, (req,res)=>{
    console.log("server started on port 3000")
})