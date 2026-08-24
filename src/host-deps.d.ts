declare module 'schemastery' {
  const schema: any
  export default schema
}

declare module '@deepseek-ai/dsh-settings' {
  export function installSettingsSection(...args: any[]): void
  export function settingsNamespace(value: string): string
}

declare module '@deepseek-ai/schemastery' {
  const schema: any
  export default schema
}
