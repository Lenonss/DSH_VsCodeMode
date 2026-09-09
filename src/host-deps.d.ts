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

// @deepseek-ai/dsh-llm 不在此声明（ambient 模块无法被 import 且与 Ctx=any 惯例冲突）：
// AI 补全消费的最小类型面见 src/ai/llmTypes.ts，运行时值经 ctx.get('llm') 获取。

