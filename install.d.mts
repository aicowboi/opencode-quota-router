export const INSTALL_VERSION: string
export type InstallOptions = { package?: string; config?: string; installDir?: string; dryRun?: boolean; help?: boolean }
export type InstallRuntime = { env?: NodeJS.ProcessEnv; home?: string; nodeVersion?: string; runNpm?: (args: string[], cwd: string) => Promise<string> }
export type InstallResult = { dryRun: boolean; config: string; source: string; version: string; installed?: string; backup?: string; changed: boolean; reused?: boolean }
export function parseJSONC(source: string): { kind: string; value: Record<string, any>; [key: string]: any }
export function editConfig(source: string, installed: string, directory?: string): { text: string; changed: boolean; action: string }
export function parseInstallArgs(argv: string[]): InstallOptions
export function resolveNpm(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, executable?: string): { command: string; prefix: string[] }
export function install(options?: InstallOptions, runtime?: InstallRuntime): Promise<InstallResult>
export function installerMain(argv?: string[], out?: { log: (message: string) => void; err: (message: string) => void }, runtime?: InstallRuntime): Promise<number>
