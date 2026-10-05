import test from 'node:test'
import assert from 'node:assert/strict'
import {projectCopiedProjectState,summarizeCopiedProjectState,copiedProjectStateLimit} from '../src/main/copiedProjectState'

function source(){return {
  'local-projects':{legacy:{id:'legacy',name:'中文项目',rootPaths:['/external/project','/source/home/worktrees/a'],createdAt:123,updatedAt:456,unknownPermissions:{allow:true}}},
  'electron-saved-workspace-roots':['/external/project','/source/home/worktrees/a','/source/home-other'],
  'electron-workspace-root-labels':{'/external/project':'外部项目','/source/home/worktrees/a':'实例工作树'},
  'project-order':['legacy','/source/home/worktrees/a'],
  'thread-project-assignments':{thread:{projectId:'legacy',projectKind:'local',secret:'never copy'},missing:{projectId:'legacy',projectKind:'local'}},
  'projectless-thread-ids':['projectless','missing'],
  'pinned-thread-ids':['thread','missing'],
  'pinned-project-ids':['legacy'],
  'thread-workspace-root-hints':{thread:'/external/project',missing:'/missing'},
  'thread-projectless-output-directories':{projectless:'/source/home/worktrees/a',missing:'/missing'},
  'sidebar-project-thread-orders':{legacy:{threadIds:['thread','missing'],sortKey:'updated_at',unknown:'never copy'}},
  'app-server-project-id-by-legacy-project-id-by-host':{'local:/source/home':{legacy:'server-uuid'},'local:/another/home':{foreign:'foreign-server-id'}},
  'app-server-projects-migration-by-host':{'local:/source/home':{version:1,projectsMigrated:true,threadAssignmentsMigrated:true,threadAssignmentsReadMigrated:true,pendingThreadAssignmentIds:['thread','missing'],unknown:'never copy'}},
  'permissions':{allow:true},'analytics':{enabled:true},'environment':{secret:'never copy'},'auth':{key:'never copy'},
  'electron-persisted-atom-state':{locale:'en-US'},'user-id':'another-identity'
}}

test('project state projection preserves project membership, names and order without desktop identity or permissions',()=>{
  const input=source(),raw=JSON.stringify(input),state=projectCopiedProjectState(raw,{sourceHome:'/source/home',targetHome:'/target/home',threadIds:new Set(['thread','projectless'])})
  assert.deepEqual(state,{
    'local-projects':{legacy:{id:'legacy',name:'中文项目',rootPaths:['/external/project','/target/home/worktrees/a'],createdAt:123,updatedAt:456}},
    'electron-saved-workspace-roots':['/external/project','/target/home/worktrees/a','/source/home-other'],
    'electron-workspace-root-labels':{'/external/project':'外部项目','/target/home/worktrees/a':'实例工作树'},
    'project-order':['legacy','/target/home/worktrees/a'],
    'thread-project-assignments':{thread:{projectId:'legacy',projectKind:'local'}},
    'projectless-thread-ids':['projectless'],'pinned-thread-ids':['thread'],'pinned-project-ids':['legacy'],
    'thread-workspace-root-hints':{thread:'/external/project'},
    'thread-projectless-output-directories':{projectless:'/target/home/worktrees/a'},
    'sidebar-project-thread-orders':{legacy:{threadIds:['thread'],sortKey:'updated_at'}},
    'app-server-project-id-by-legacy-project-id-by-host':{'local:/target/home':{legacy:'server-uuid'}},
    'app-server-projects-migration-by-host':{'local:/target/home':{version:1,projectsMigrated:true,threadAssignmentsMigrated:false,threadAssignmentsReadMigrated:false,pendingThreadAssignmentIds:['thread']}}
  })
  assert.equal(JSON.stringify(input),raw)
  assert.deepEqual(summarizeCopiedProjectState(state),{projects:1,workspaceRoots:3,assignedThreads:1,projectlessThreads:1,workspaceHints:1,outputDirectories:1,orderedProjects:2})
})

test('full-profile projection keeps all copied thread IDs and absent metadata stays absent',()=>{
  const state=projectCopiedProjectState(JSON.stringify(source()),{sourceHome:'/source/home',targetHome:'/source/home'})
  assert.equal(Object.keys(state['thread-project-assignments'] as object).length,2)
  assert.deepEqual(state['projectless-thread-ids'],['projectless','missing'])
  assert.deepEqual(projectCopiedProjectState('{"locale":"zh-CN","auth":{"key":"no"}}'),{})
  assert.deepEqual(summarizeCopiedProjectState({}),{projects:0,workspaceRoots:0,assignedThreads:0,projectlessThreads:0,workspaceHints:0,outputDirectories:0,orderedProjects:0})
})

test('an unmatched host never inherits a completed source project migration',()=>{
  const state=projectCopiedProjectState(JSON.stringify(source()),{sourceHome:'/different/home',targetHome:'/target/home'})
  assert.equal(state['app-server-project-id-by-legacy-project-id-by-host'],undefined)
  assert.equal(state['app-server-projects-migration-by-host'],undefined)
  const input=source();input['app-server-project-id-by-legacy-project-id-by-host']={'local:/another/home':{foreign:'foreign-server-id'}} as ReturnType<typeof source>['app-server-project-id-by-legacy-project-id-by-host']
  const withoutMapping=projectCopiedProjectState(JSON.stringify(input),{sourceHome:'/source/home',targetHome:'/target/home'})
  assert.equal((withoutMapping['app-server-projects-migration-by-host'] as Record<string,Record<string,unknown>>)['local:/target/home'].projectsMigrated,false)
})

test('malformed recognized project metadata and oversized input fail instead of silently losing grouping',()=>{
  for(const raw of ['{','[]','null',JSON.stringify({'local-projects':[]}),JSON.stringify({'local-projects':{p:{id:'p',name:'project',rootPaths:1}}}),JSON.stringify({'thread-project-assignments':{t:null}}),JSON.stringify({'project-order':[1]}),JSON.stringify({'thread-workspace-root-hints':{t:42}}),JSON.stringify({'sidebar-project-thread-orders':{p:[]}}),JSON.stringify({'sidebar-project-thread-orders':{p:{threadIds:[],sortKey:'invalid'}}}),JSON.stringify({'app-server-projects-migration-by-host':{'local:/source/home':{version:2}}})]){
    assert.throws(()=>projectCopiedProjectState(raw,{sourceHome:'/source/home',targetHome:'/target/home'}),/分组状态格式不兼容/)
  }
  assert.throws(()=>projectCopiedProjectState(' '.repeat(copiedProjectStateLimit+1)),/size/)
})
