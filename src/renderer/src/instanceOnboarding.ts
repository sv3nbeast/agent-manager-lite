import type { AgentClientType } from '../../shared/agentClients'
export interface InstanceLoginRequest {requestId:string;clientType:AgentClientType}
export interface InstanceLoginResult extends InstanceLoginRequest {accountId:string}
