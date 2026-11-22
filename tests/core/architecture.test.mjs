import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {isBuiltin} from 'node:module';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import ts from 'typescript';

test('shared/core and its local runtime dependencies have no host imports or DOM access',()=>{
  const shared=new URL('../../shared/',import.meta.url);
  const core=new URL('core/',shared);
  const visited=new Set();
  function inspect(url){
    if(visited.has(url.href))return;
    assert(url.href.startsWith(shared.href),'non-shared dependency '+url.href);
    visited.add(url.href);
    const file=fileURLToPath(url);
    const tree=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    function visit(node){
      if(ts.isIdentifier(node)||ts.isStringLiteralLike(node)){
        const property=ts.isPropertyAccessExpression(node.parent)||ts.isElementAccessExpression(node.parent);
        const reference=ts.isIdentifier(node)&&!ts.isPropertyAssignment(node.parent);
        assert(!((property||reference)&&/^(window|document)$/.test(node.text)),'DOM access in '+file);
      }
      let specifier;
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))specifier=node.moduleSpecifier;
      if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||
        ts.isIdentifier(node.expression)&&node.expression.text==='require')){
        specifier=node.arguments[0];
        assert(specifier&&ts.isStringLiteralLike(specifier),'nonliteral module import in '+file);
      }
      if(specifier&&ts.isStringLiteralLike(specifier)){
        const name=specifier.text;
        if(name.startsWith('.'))inspect(new URL(name,url));
        else assert(name==='buffer'||(!isBuiltin(name)&&! /^(?:electron(?:\/|$)|@electron\/|@capacitor\/)/.test(name)),
          'host module '+name+' in '+file);
      }
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  for(const name of readdirSync(core))if(name.endsWith('.mjs'))inspect(new URL(name,core));
});
