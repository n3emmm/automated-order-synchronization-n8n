const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workflow = require('../workflow.json');
const orders = require('../fixtures/orders.json');
const node = name => workflow.nodes.find(n => n.name === name);
const source = fs.readFileSync(path.join(root,'src/sync.js'),'utf8');
const apply = new Function(source+'\nreturn transition')();
const initial = () => new Function(node('Configuration').parameters.jsCode)()[0].json;
const header = ['order_id','status','total_minor','currency','updated_at'];
const ok = body => ({statusCode:200,body});
function planned(records,rows=[header]){
  const s=initial();
  apply(s,ok({orders:records,next_cursor:null}));
  return apply(s,ok({values:rows}));
}
test('released graph, safe defaults and embedded source',()=>{
  assert.equal(workflow.active,false);
  assert.equal(node('Daily (disabled)').disabled,true);
  assert.ok(node('Apply response').parameters.jsCode.startsWith(source));
  for(const links of Object.values(workflow.connections))
    for(const port of links.main) for(const dest of port) assert.ok(node(dest.node));
});
test('empty store terminates cleanly',()=>assert.equal(planned([]).op,'done'));
test('250 distinct ids across five pages',()=>{
  const s=initial();
  for(let i=0;i<5;i++) apply(s,ok({orders:orders.slice(50*i,50*i+50),next_cursor:i===4?null:String(i+1)}));
  assert.equal(s.pages,5);assert.equal(s.op,'index');assert.equal(Object.keys(s.orders).length,250);
});
test('cursor cycle and ceiling abort before writes',()=>{
  for(const limit of [1,2]){
    const s=initial();s.maxPages=limit;
    while(!s.fatal) apply(s,ok({orders:[],next_cursor:'same'}));
    assert.equal(s.fatal,limit===1?'page_limit':'invalid_or_repeated_cursor');
  }
});
test('invalid source envelope never implies end of feed',()=>assert.equal(apply(initial(),ok({orders:[]})).fatal,'invalid_page'));
test('bad date, invalid record and conflicting duplicate isolated',()=>{
  const a=orders[0],b=orders[1];
  const s=planned([a,a,{...a,status:'pending'},null,{...a,updated_at:'2025-02-30T00:00:00Z'},b]);
  assert.equal(s.errors.length,3);assert.equal(s.duplicates,1);assert.deepEqual(s.batch.map(e=>e.values[0]),[b.order_id]);
});
test('header and duplicate destination keys fail closed',()=>{
  assert.equal(planned(orders,[[]]).fatal,'invalid_sheet_header');
  assert.equal(planned(orders,[header,['x'],['x']]).fatal,'missing_or_duplicate_sheet_id');
});
test('read-after-commit confirms inserts without second write',()=>{
  const s=planned(orders.slice(0,2));
  const rows=[header,...s.batch.map(e=>e.values)];
  apply(s,{});assert.equal(s.op,'verify');apply(s,ok({values:rows}));
  assert.equal(s.counts.added,2);assert.equal(s.op,'done');
  assert.equal(planned(orders.slice(0,2),rows).counts.skipped,2);
});
test('short acknowledgement and mixed verification retry only missing fixed row',()=>{
  const s=planned(orders.slice(0,2)),first=s.batch[0];
  apply(s,ok({}));apply(s,ok({values:[header,first.values]}));
  assert.equal(s.counts.added,1);assert.equal(s.batch[0].row,3);assert.equal(s.attempt,2);
});
test('changed occupant aborts reconciliation',()=>{
  const s=planned([orders[0]]);apply(s,{});apply(s,ok({values:[header,['different']]}));
  assert.equal(s.fatal,'writer_conflict');
});
test('429 honors delta/date, default exponential and cap',()=>{
  for(const [value,expected] of [['4',4],['Thu, 01 Jan 1970 00:00:09 GMT',9],['invalid',1]]){
    const s=initial();apply(s,{statusCode:429,headers:{'retry-after':value}},0);assert.equal(s.delay,expected);
    apply(s,{statusCode:503});assert.equal(s.delay,2);apply(s,{statusCode:503});assert.equal(s.fatal,'page_retry_exhausted');
  }
});
test('401 and 403 stop immediately on every operation',()=>{
  for(const op of ['index','page','verify','write']) for(const code of [401,403]){
    const s=initial();s.op=op;apply(s,{statusCode:code});assert.equal(s.fatal,'authentication_'+code);
  }
});
test('batch rejection isolates bad row within total write budget',()=>{
  const s=planned(orders.slice(0,2));apply(s,{statusCode:400});
  assert.equal(s.attempt,2);apply(s,{statusCode:400});assert.equal(s.errors.length,1);
  assert.equal(s.batch[0].values[0],orders[1].order_id);apply(s,ok({totalUpdatedRows:1}));assert.equal(s.counts.added,1);
});
test('mixed upsert keeps existing physical rows and allocates after last occupied row',()=>{
  const rows=[header,...planned(orders.slice(0,2)).batch.map(e=>e.values)];
  const s=planned([orders[1],orders[2],{...orders[0],status:'pending'}],rows);
  assert.equal(s.counts.skipped,1);
  assert.deepEqual(s.batch.map(e=>[e.values[0],e.row,e.kind]),[[orders[2].order_id,4,'added'],[orders[0].order_id,2,'updated']]);
});
