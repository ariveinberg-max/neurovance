// Isolated handler regressions: no credentials, database, or external requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function route(start, end) {
  return server.slice(server.indexOf(start), server.indexOf(end, server.indexOf(start)));
}

for (const [path, nextPath, payload, field, expected] of [
  ['/api/token-budget', '/api/strict-mode', { budget: 1000 }, 'tokenBudget', 1000],
  ['/api/strict-mode', '/api/session/clear', { enabled: true }, 'strictModeEnabled', true],
]) {
  test(`${path} updates the authenticated user without shadowing`, async () => {
    const handler = new AsyncFunction('req','res','user','auth','readJsonBody','sendJson',
      route(`    if (req.url === '${path}'`, `    if (req.url === '${nextPath}'`));
    let saved;
    const result = await handler({url:path,method:'POST'}, {}, {id:'fixture-user'}, {
      findUserById: async id => { assert.equal(id, 'fixture-user'); return {id}; },
      saveUser: async user => { saved = user; },
    }, async () => payload, (_res,status,body) => ({status,body}));
    assert.equal(result.status, 200);
    assert.equal(saved[field], expected);
  });
}

test('every code endpoint is gated before any filesystem handler', async () => {
  const start = "    if (req.url.startsWith('/api/code/')";
  const block = server.slice(server.indexOf(start), server.indexOf('\n    }', server.indexOf(start)) + 6);
  assert.ok(server.indexOf(start) < server.indexOf("    if (req.url === '/api/code/files'"));
  const gate = new AsyncFunction('req','res','process','codeExecution','sendJson', block);
  for (const path of ['files','files/get','files/save','files/remove','files/search','prompt','run']) {
    for (const [render,enabled,denied] of [[undefined,false,true],['true',true,true],['true',false,true],[undefined,true,false]]) {
      const result = await gate({url:`/api/code/${path}`},{},{env:{RENDER:render}},
        {isExecutionEnabled:()=>enabled},(_res,status,body)=>({status,body}));
      assert.equal(result?.status, denied ? 403 : undefined);
    }
  }
});

test('graph containment leaves uninitialized coordinates untouched', () => {
  const start = html.indexOf('  function adaptiveSphere(');
  const end = html.indexOf("  Graph.d3Force('sphere'", start);
  const makeForce = new Function(html.slice(start,end) + '; return adaptiveSphere;')();
  const nodes = [{}, {x:200,y:0,z:0,vx:0,vy:0,vz:0}];
  const force = makeForce(()=>100);
  force.initialize(nodes); force(0.5);
  assert.deepEqual(nodes[0], {});
  assert.ok(Number.isFinite(nodes[1].vx));
  assert.ok(nodes[1].vx < 0);
});

test('graph shell waits until every node has finite coordinates', () => {
  const start = html.indexOf('  function refreshShell()');
  const end = html.indexOf('\n  refreshShell();', start);
  let touched = false;
  const refresh = new Function('allNodes','shellMesh', html.slice(start,end) + '; return refreshShell;')(
    [{x:undefined,y:undefined,z:undefined}],
    {scale:{set:()=>{touched=true;}},position:{set:()=>{touched=true;}}});
  refresh();
  assert.equal(touched,false);
});
