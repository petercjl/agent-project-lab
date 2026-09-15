import {execFileSync} from 'node:child_process';
function cli(...args:string[]){const out=JSON.parse(execFileSync(process.execPath,['bin/projectctl.mjs',...args],{encoding:'utf8'}));if(!out.ok)throw Error(JSON.stringify(out));return out.data;}
const name='ERM 保温杯 · 本地预演';
const exists=cli('project','list').find((p:any)=>p.name===name);
if(exists){console.log(JSON.stringify({existing:true,project:exists.id}));process.exit(0);}
const p=cli('project','create','--name',name,'--goal','验证 Agent 管理商品项目：任务推进、知识沉淀、人工审核与自动交接。演示采用固定输入。');
const tasks=cli('task','list','--project',p.id);
for(let i=0;i<2;i++){
 const t=tasks[i];cli('task','start','--id',t.id);
 const run=cli('run','start','--task',t.id,'--skill','固定输入 CLI 流程预演（非实时业务 Skill）','--skill-version','0.1.0','--input','用户需求与本地示例 Markdown');
 const file=i===0?'examples/立项预演.md':'examples/市场调研预演.md';
 cli('wiki','write','--project',p.id,'--path',t.wikiPath,'--file',file,'--run',run.id);
 cli('artifact','add','--task',t.id,'--file',file);
 cli('run','finish','--id',run.id,'--status','completed','--output','示例文档已写入 Wiki，原文作为附件保存','--quality','流程验证；未采集市场数据，不用于业务决策');
 cli('task','submit','--id',t.id);
 if(i===0)cli('task','approve','--id',t.id,'--actor','supervisor');
}
console.log(JSON.stringify({project:p.id,reviewTask:tasks[1].id,nextTask:tasks[2].id},null,2));
