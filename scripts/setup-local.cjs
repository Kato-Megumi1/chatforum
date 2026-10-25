// Generates local-only credentials. Existing configuration is never overwritten.
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const root=path.resolve(__dirname,'..'),hex=()=>randomBytes(32).toString('hex');
function create(relative,content){const target=path.join(root,relative);if(fs.existsSync(target)){console.log('Preserved '+relative);return;}
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content,{flag:'wx',mode:0o600});console.log('Created '+relative+' (private; excluded from Git)');}
create('docker/.env',[
 'MYSQL_ROOT_PASSWORD='+hex(),'MYSQL_PASSWORD='+hex(),'JWT_ACCESS_SECRET='+hex(),'JWT_REFRESH_SECRET='+hex(),
 'CORS_ORIGIN=http://localhost:8080,http://localhost:5173','',
].join('\n'));
create('backend/.env',fs.readFileSync(path.join(root,'backend/.env.example'),'utf8'));
create('.local/admin-bootstrap.env',['ADMIN_EMAIL=admin@chatforum.local','ADMIN_PASSWORD='+hex(),''].join('\n'));
console.log('Local model keys stay in backend/.env. After Docker starts, run node scripts/bootstrap-local.cjs.');
