// Isolated fake-backend fixture only. Never enabled by the released patch.
export function apply(ctx) {
  ctx.on('user-questions/request', request => ({ answers: request.questions.map(question => ({
    id: question.id, selected: [question.id === 'dynamic-context-execution' ? '规划完成后直接执行（推荐）'
      : question.id === 'dynamic-context-plan-approval' ? '确认并开始执行' : '启用完整任务图功能（推荐）'],
  })) }), { prepend: true, global: true })
}
