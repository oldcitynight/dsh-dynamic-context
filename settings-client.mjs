// SPDX-License-Identifier: GPL-3.0-only
export const preferenceFields = [
  { key: 'permissionMode', label: '执行权限', hint: '继承主会话；选定的上限不会扩大主会话授权。', choices: [['configured', '按配置'], ['auto', '继承'], ['read-only', '只读'], ['workspace-write', '工作区'], ['danger-full-access', '完整访问']] },
  { key: 'approvalPolicy', label: '工具批准', hint: '主会话的批准策略始终生效。', choices: [['configured', '按配置'], ['auto', '继承'], ['ask', '可询问'], ['never', '不询问']] },
  { key: 'reasoningEffort', label: '推理强度', hint: '自动继承主会话；明确强度仅适用于 DeepSeek 接口。', choices: [['configured', '按配置'], ['auto', '继承'], ['off', '关闭'], ['low', '低'], ['high', '高'], ['max', '最高']] },
  { key: 'maxGroupDepth', label: '组嵌套层数', hint: '0 沿用配置文件；1–16 层，包含根层，不含叶任务。', min: 0, max: 16 },
  { key: 'contextWindow', label: '上下文窗口（token）', hint: '0 沿用配置文件；131072–1048576。同步原生压缩阈值，不改变模型实际容量。', min: 131072, max: 1048576, zero: true },
  { key: 'maxRequestsPerTask', label: '每角色额外请求次数上限', min: 1, max: 256, limit: true },
  { key: 'timeoutMs', label: '每角色额外超时（毫秒）', min: 10, max: 1800000, limit: true },
  { key: 'maxContextCharacters', label: '请求上下文字符上限', min: 1, max: 8388608, limit: true },
  { key: 'maxReportCharacters', label: '报告字符上限', min: 1, max: 8388608, limit: true },
  { key: 'maxToolOutputCharacters', label: '工具输出字符上限', min: 256, max: 8388608, limit: true },
]
// Reuse the native staged form and conflict detection over one nested section.
export function preferenceScope(scope) {
  return { subscribe: listener => scope.subscribe(listener),
    getSnapshot() { const snapshot = scope.getSnapshot(); return { ...snapshot,
      value: snapshot.value?.preferences, base: snapshot.base?.preferences, user: snapshot.user?.preferences } },
    mutate: (ops, revision) => scope.mutate(ops.map(op => ({ ...op, path: ['preferences', ...op.path] })), revision) }
}
export function installPreferenceSettings(ctx, React, primitives) {
  const { SettingsForm, SettingsFormModel, SettingsValueField, SegmentedControl, Button, settingsNumberField, settingsTextField } = primitives
  if (!ctx.inject || !SettingsFormModel) return
  ctx.inject(['configForms', 'locale'], scoped => {
    const ns = 'dsh-dynamic-context', locale = 'settings.dynamicContext', h = React.createElement
    const description = '仅影响之后新启用的完整任务图；已有任务保留其设置。主会话权限修改会实时生效。'
    scoped.effect(() => scoped.locale.register(locale, { zh: { title: '动态上下文', description }, en: { title: 'Dynamic context', description } }))
    const specs = preferenceFields.map(field => {
      const original = field.choices ? settingsTextField(field.key) : settingsNumberField(field.key)
      return { ...original, parse(text) {
        const value = original.parse(text)
        if (value?.kind !== 'set') return value
        if (field.choices) return field.choices.some(([key]) => key === value.value) ? value : undefined
        const n = value.value
        return Number.isInteger(n) && (field.limit && [-1, 0].includes(n) || field.zero && n === 0 || n >= field.min && n <= field.max) ? value : undefined
      } }
    })
    const form = new SettingsFormModel(preferenceScope(scoped.configForms.get(ns)), specs)
    const store = form.bind(() => ({ ...form.shell(), fields: Object.fromEntries(preferenceFields.map(field => [field.key, form.field(field.key)])) }))
    scoped.effect(() => () => form.dispose())
    function Card(props) {
      const state = props.useDynamicContextSettings(snapshot => snapshot)
      if (props.view === 'summary') return description
      return h(SettingsForm, { state, labels: { unavailable: '插件尚未加载。', readOnly: '当前部署不允许修改设置。', saveFailed: '保存未通过，请检查字段或重新加载最新设置。', save: '保存', saving: '保存中…' },
        onSave: props.save, onDiscard: props.discard },
      ...preferenceFields.map(field => {
        const value = state.fields[field.key], id = 'dynamic-context-setting-' + field.key
        if (field.choices) return h('div', { key: field.key, style: { marginBottom: 20 } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
            h('span', null, field.label), value.overridden ? h(Button, { size: 'small', variant: 'ghost', disabled: !state.writable, onClick: () => props.resetField(field.key) }, '恢复默认') : null),
          h(SegmentedControl, { id, value: value.text, label: field.label, disabled: !state.writable,
            options: field.choices.map(([value, label]) => ({ value, label })), onChange: text => props.edit(field.key, text) }),
          h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, field.hint))
        return h(SettingsValueField, { key: field.key, id, ...value, label: field.label,
          hint: field.hint ?? '-1 沿用配置文件，0 不额外限制；原生单次请求控制仍然有效。', numeric: true,
          overriddenLabel: '已覆盖', resetLabel: '恢复默认', invalidLabel: '请输入说明范围内的整数。', disabled: !state.writable,
          onEdit: text => props.edit(field.key, text), onReset: () => props.resetField(field.key) })
      }))
    }
    scoped.effect(() => scoped.configForms.whileServed([ns], () => scoped.slots.inject('plugins.item', () => scoped.slots.register({
      name: 'plugins.item', id: ns, order: 55, label: () => scoped.locale.bind(locale)('title'), locale,
      inject: () => ({ hooks: { dynamicContextSettings: store }, ...form.actions() }),
    }, Card))))
  })
}
