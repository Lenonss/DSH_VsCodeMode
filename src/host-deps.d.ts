declare module 'schemastery' {
  const schema: any
  export default schema
}

declare module '@deepseek-ai/schemastery' {
  const schema: any
  export default schema
}

// @deepseek-ai/dsh-settings 不在此声明：rc 线导出 installSettingsSection /
// settingsNamespace，0.1.2-alpha 起移除（改由 settings 服务 installSection 方法承载）。
// fileOpenSettings.ts 以动态导入 + 属性探测方式访问，见 SettingsDeps.installSettingsSection。

