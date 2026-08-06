const express = require('express');
const { v2 } = require('webdav-server');
const { VirtualFileSystem } = require('./dist/modules/webdav/webdav-virtual-fs.js');
// minimal clone of routes.ts + auth middleware
const crypto = require('crypto');
function sha256(v){return crypto.createHash('sha256').update(v).digest();}
function requireWebDavAuth(req,res,next){
  if(!process.env.WEBDAV_PASSWORD){return res.status(503).json({code:'WEBDAV_NOT_CONFIGURED'});}
  const header=req.header('Authorization');
  if(!header||!header.startsWith('Basic ')){res.setHeader('WWW-Authenticate','Basic realm="9Drive WebDAV"');return res.status(401).json({code:'WEBDAV_AUTH_REQUIRED'});}
  let password='';
  try{ const d=Buffer.from(header.slice(6),'base64').toString('utf8'); const s=d.indexOf(':'); password=s===-1?'':d.slice(s+1);}catch{}
  const a=sha256(process.env.WEBDAV_PASSWORD), b=sha256(password);
  const ok=a.length===b.length&&crypto.timingSafeEqual(a,b);
  if(!ok){res.setHeader('WWW-Authenticate','Basic realm="9Drive WebDAV"');return res.status(401).json({code:'WEBDAV_AUTH_INVALID'});}
  return next();
}
class ReadOnlyPM extends v2.PrivilegeManager {
  _can(fullPath,user,resource,privilege,callback){ console.log('PM._can', privilege); if(privilege.startsWith('canWrite')) return callback(v2.Errors.Forbidden,false); callback(null,true); }
}
const auth2 = { askForAuthentication(){return{};}, getUser(ctx,cb){cb(null,new v2.SimpleUser('9drive','',false,true));} };
const server = new v2.WebDAVServer({ requireAuthentification:false, httpAuthentication: auth2, privilegeManager: new ReadOnlyPM() });
server.setFileSystemSync('/', new VirtualFileSystem());
const app = express();
app.use('/webdav', requireWebDavAuth, (req,res)=>{ server.executeRequest(req,res); });
const srv = app.listen(0, ()=>{
  const port = srv.address().port;
  const http=require('http');
  const req=http.request({port,method:'PUT',path:'/webdav/test.txt',headers:{'Content-Length':'0',Authorization:'Basic '+Buffer.from('anything:sekret').toString('base64')}},(res)=>{ console.log('PUT via express:',res.statusCode); process.exit(0); });
  req.end();
});
