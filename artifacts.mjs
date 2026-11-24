// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path'
import { digest, GraphError } from 'dsh-better-task-grapth/core'
import { artifactProof as prove, artifactCurrentIdentity as identify, readArtifactIdentity as readIdentity, realProjectPath as realPath } from 'dsh-better-task-grapth/host'
import { storedEntry, statStored } from './workflow-io.mjs'

export function realProjectPath(root, requested, options) {
  if(options?.directory===false && storedEntry(requested)) {
    realPath(root,path.dirname(requested));return requested
  }
  return realPath(root,requested,options)
}
export function readArtifactIdentity(root,ref,signal,options={maxBytes:null}){
  const file=path.resolve(root,ref.ref), entry=storedEntry(file)
  if(!entry)return readIdentity(root,ref,signal,options)
  signal?.throwIfAborted();realProjectPath(root,file,{directory:false})
  if(options.maxBytes!==null && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes<1))throw new GraphError('ARTIFACT_BYTE_POLICY_INVALID')
  if(options.maxBytes!==null && entry.info.size>options.maxBytes)throw new GraphError('ARTIFACT_BYTE_LIMIT')
  // A proof checks the backing bytes, including external media, against their recorded identity.
  entry.db.range(entry.info)
  const meta=statStored(file,{bigint:true})
  return {kind:'artifact',refDigest:digest(ref),path:file,sha256:entry.info.sha,
    stat:Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(key=>[key,String(meta[key])]))}
}
export function artifactProof(root,ref,signal,options={maxBytes:null}){
  if(!storedEntry(path.resolve(root,ref.ref)))return prove(root,ref,signal,options)
  if(!ref.sha256)throw new GraphError('ARTIFACT_SHA_REQUIRED')
  const identity=readArtifactIdentity(root,ref,signal,options)
  if(ref.sha256!==identity.sha256)throw new GraphError('ARTIFACT_CHANGED_OR_HASH_MISMATCH',{path:'/sha256',item:ref.ref,expected:ref.sha256,observed:identity.sha256})
  return identity
}
export function artifactCurrentIdentity(root,ref,signal,options={maxBytes:null}){
  if(!storedEntry(path.resolve(root,ref.ref)))return identify(root,ref,signal,options)
  if(!ref.sha256)throw new GraphError('ARTIFACT_SHA_REQUIRED')
  const id=readArtifactIdentity(root,ref,signal,options)
  return {ref:id.path,acceptedSha256:ref.sha256,currentSha256:id.sha256,status:id.sha256===ref.sha256?'UNCHANGED':'CHANGED',stat:id.stat}
}
