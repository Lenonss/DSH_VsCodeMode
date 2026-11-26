/* 05 · 属性面板：改数值、锚点、文字、绑定，存库入口 */
(function (UK) {
  'use strict'

  var KINDS = ['group', 'text', 'image', 'sprite', 'button', 'list', 'prefab']
  var PRESETS = [
    { id: 'tl', mark: '↖', min: [0, 0], max: [0, 0] }, { id: 't', mark: '↑', min: [0.5, 0], max: [0.5, 0] }, { id: 'tr', mark: '↗', min: [1, 0], max: [1, 0] },
    { id: 'l', mark: '←', min: [0, 0.5], max: [0, 0.5] }, { id: 'c', mark: '●', min: [0.5, 0.5], max: [0.5, 0.5] }, { id: 'r', mark: '→', min: [1, 0.5], max: [1, 0.5] },
    { id: 'bl', mark: '↙', min: [0, 1], max: [0, 1] }, { id: 'b', mark: '↓', min: [0.5, 1], max: [0.5, 1] }, { id: 'br', mark: '↘', min: [1, 1], max: [1, 1] }
  ]
  var extractTarget = null

  function field(label, control) {
    return UK.el('div', { class: 'ui-field' }, [UK.el('label', { text: label }), control])
  }

  function numInput(value, onCommit, step) {
    var input = UK.el('input', { type: 'number', step: step || '1', value: value })
    input.addEventListener('change', function () { onCommit(Number(input.value)) })
    return input
  }

  function setField(node, path, value) {
    UK.commit({ op: 'set', id: node.id, field: path, value: value })
  }

  function anchorOf(node) {
    var a = node.anchor || {}
    return {
      min: a.min || [0, 0],
      max: a.max || [0, 0],
      pivot: a.pivot || [0, 0]
    }
  }

  function presetId(anchor) {
    var hit = PRESETS.filter(function (p) {
      return p.min[0] === anchor.min[0] && p.min[1] === anchor.min[1] &&
        p.max[0] === anchor.max[0] && p.max[1] === anchor.max[1]
    })[0]
    return hit ? hit.id : ''
  }

  UK.syncInspectorRect = function (rect) {
    var ids = ['in-x', 'in-y', 'in-w', 'in-h']
    ids.forEach(function (id, i) {
      var input = document.getElementById(id)
      if (input) input.value = rect[i]
    })
  }

  UK.renderInspector = function (host) {
    host.innerHTML = ''
    var node = UK.selectedNode()
    var head = UK.el('div', { class: 'ui-pane-head' }, [UK.el('span', { text: '属性' })])
    host.appendChild(head)

    if (!node) {
      host.appendChild(UK.el('div', { class: 'ui-empty-note', text: '在左边树或画布上选一个节点。' }))
      host.appendChild(UK.el('div', { class: 'ui-group' }, [
        UK.el('div', { class: 'ui-hint' }, [
          UK.el('div', { text: '滚轮缩放 · 空白拖动画布 · 方向键微调 · Delete 删除' })
        ])
      ]))
      return
    }

    var rect = node.rect || [0, 0, 0, 0]

    /* 基本 */
    var basic = UK.el('div', { class: 'ui-group' }, [
      UK.el('h4', { text: '基本' }),
      UK.el('div', { class: 'ui-id', text: node.id }),
      UK.el('div', { class: 'ui-grid2', style: { 'margin-top': '8px' } }, [
        field('类型', (function () {
          var sel = UK.el('select', {}, KINDS.map(function (k) {
            return UK.el('option', { value: k, text: k, selected: node.kind === k })
          }))
          sel.addEventListener('change', function () {
            setField(node, 'kind', sel.value)
            if (sel.value === 'text' && !node.text) {
              UK.commit({ op: 'set', id: node.id, field: 'text', value: { s: '文本', size: 24, color: '#333333' } })
            }
          })
          return sel
        })()),
        field('绑定', (function () {
          var input = UK.el('input', { type: 'text', value: node.bind || '', placeholder: '可选' })
          input.addEventListener('change', function () {
            if (input.value) setField(node, 'bind', input.value)
            else UK.commit({ op: 'set', id: node.id, field: 'bind', value: null })
          })
          return input
        })())
      ])
    ])
    host.appendChild(basic)

    /* 矩形 */
    var rectGroup = UK.el('div', { class: 'ui-group' }, [
      UK.el('h4', { text: '位置与尺寸（父节点局部）' }),
      UK.el('div', { class: 'ui-grid2' }, [
        field('X', numInput(rect[0], function (v) { setRect(node, 0, v) })),
        field('Y', numInput(rect[1], function (v) { setRect(node, 1, v) })),
        field('宽', numInput(rect[2], function (v) { setRect(node, 2, Math.max(4, v)) })),
        field('高', numInput(rect[3], function (v) { setRect(node, 3, Math.max(4, v)) }))
      ])
    ])
    host.appendChild(rectGroup)

    /* 锚点 */
    var anchor = anchorOf(node)
    var active = presetId(anchor)
    var presetBox = UK.el('div', { class: 'ui-preset' }, PRESETS.map(function (p) {
      return UK.el('button', {
        title: p.id,
        text: p.mark,
        style: active === p.id ? { background: 'var(--uk-accent)', borderColor: 'var(--uk-accent)', color: '#fff' } : null,
        onclick: function () {
          UK.commit({
            op: 'set', id: node.id, field: 'anchor',
            value: { min: p.min.slice(), max: p.max.slice(), pivot: p.min.slice() }
          })
        }
      })
    }))
    var anchorGroup = UK.el('div', { class: 'ui-group' }, [
      UK.el('h4', { text: '锚点' }),
      UK.el('div', { style: { display: 'flex', gap: '10px', 'align-items': 'flex-start' } }, [
        presetBox,
        UK.el('div', { class: 'ui-hint', style: { 'flex': '1' } }, [
          UK.el('div', { text: active ? '当前：' + active : '当前：自定义（满铺或手改）' }),
          UK.el('div', { text: '窄屏拉伸时按锚点重算位置' })
        ])
      ])
    ])
    host.appendChild(anchorGroup)

    /* 文本 */
    if (node.kind === 'text') {
      var text = node.text || { s: '', size: 24, color: '#333333' }
      var area = UK.el('textarea', { rows: '2' })
      area.value = text.s || ''
      area.addEventListener('change', function () { setField(node, 'text.s', area.value) })
      var sizeInput = numInput(text.size || 24, function (v) { setField(node, 'text.size', Math.max(4, v)) })
      var colorInput = UK.el('input', { type: 'color', value: toHex(text.color) })
      colorInput.addEventListener('change', function () { setField(node, 'text.color', colorInput.value) })

      host.appendChild(UK.el('div', { class: 'ui-group' }, [
        UK.el('h4', { text: '文本' }),
        field('内容', area),
        UK.el('div', { class: 'ui-grid2', style: { 'margin-top': '6px' } }, [
          field('字号', sizeInput),
          field('颜色', colorInput)
        ])
      ]))
    }

    /* 引用 / 预制体 */
    if (node.ref || node.prefab || node.kind === 'list' || node.kind === 'prefab') {
      var extra = UK.el('div', { class: 'ui-group' }, [UK.el('h4', { text: '来源' })])
      if (node.prefab !== undefined) {
        var prefabInput = UK.el('input', { type: 'text', value: node.prefab || '', placeholder: 'Assets/UI/Common/CloseBtn.prefab' })
        prefabInput.addEventListener('change', function () { setField(node, 'prefab', prefabInput.value) })
        extra.appendChild(field('预制体路径', prefabInput))
        var opaqueBox = UK.el('input', { type: 'checkbox' })
        opaqueBox.checked = !!node.opaque
        opaqueBox.addEventListener('change', function () { setField(node, 'opaque', opaqueBox.checked) })
        extra.appendChild(UK.el('label', { style: { display: 'flex', gap: '6px', 'align-items': 'center', 'margin-top': '6px', 'font-size': '12px' } }, [opaqueBox, UK.el('span', { text: '内部结构未知（不往里插虚拟节点）' })]))
      }
      if (node.ref) {
        extra.appendChild(UK.el('div', { class: 'ui-id', style: { 'margin-top': '6px' }, text: node.ref }))
      }
      if (node.kind === 'list') {
        var count = numInput((node.params && node.params.count) || 5, function (v) {
          setField(node, 'params.count', Math.max(1, Math.round(v)))
        })
        extra.appendChild(UK.el('div', { style: { 'margin-top': '6px' } }, [field('示意条数', count)]))
      }
      host.appendChild(extra)
    }

    /* 动作 */
    host.appendChild(UK.el('div', { class: 'ui-group' }, [
      UK.el('h4', { text: '动作' }),
      UK.el('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap' } }, [
        UK.el('button', { class: 'ui-btn', text: '存成库条目…', onclick: function () { extractTarget = node.id; UK.renderAll() } }),
        UK.el('button', { class: 'ui-btn', text: '框定范围', onclick: function () { UK.commit({ op: 'scope', ids: [node.id] }) } }),
        UK.el('button', { class: 'ui-btn', text: '子节点加一个', onclick: function () { UK.addNode(node.id) } }),
        UK.el('button', { class: 'ui-btn', text: '删除', onclick: function () { UK.deleteNode(node.id) } })
      ])
    ]))

    if (extractTarget === node.id) host.appendChild(extractPanel(node))
  }

  function setRect(node, index, value) {
    var rect = (node.rect || [0, 0, 4, 4]).slice()
    rect[index] = Math.round(value)
    UK.commit({ op: 'set', id: node.id, field: 'rect', value: rect })
  }

  function toHex(color) {
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return color
    return '#333333'
  }

  function extractPanel(node) {
    var meta = {
      name: (node.id.split('/').pop() || node.id) + ' 条目',
      desc: '',
      when: '',
      whenNot: ''
    }
    var panel = UK.el('div', { class: 'ui-group', style: { background: '#f6f2e8' } })
    panel.appendChild(UK.el('h4', { text: '存成库条目（草稿）' }))

    ;[['name', '名称', '基础列表条目'], ['desc', '一句话描述', '左侧图标，中间标题，右侧数量'],
      ['when', '什么时候用', '列表里的一行，宽度撑满容器'], ['whenNot', '什么时候别用', '需要多列排布时']].forEach(function (row) {
      var input = UK.el('input', { type: 'text', value: meta[row[0]], placeholder: row[2] })
      input.addEventListener('input', function () { meta[row[0]] = input.value })
      panel.appendChild(field(row[1], input))
      panel.lastChild.style.marginBottom = '6px'
    })

    panel.appendChild(UK.el('div', { style: { display: 'flex', gap: '6px', 'margin-top': '8px' } }, [
      UK.el('button', {
        class: 'ui-btn ui-primary',
        text: '生成提取指令',
        onclick: function () {
          UK.commit({ op: 'extract', node: node.id, meta: meta })
          extractTarget = null
          UK.state.drawer = true
          UK.renderAll()
        }
      }),
      UK.el('button', { class: 'ui-btn', text: '取消', onclick: function () { extractTarget = null; UK.renderAll() } })
    ]))
    return panel
  }
})(window.__UIKIT__ = window.__UIKIT__ || {})
