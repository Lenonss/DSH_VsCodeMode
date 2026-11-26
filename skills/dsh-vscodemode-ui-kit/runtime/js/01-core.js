/* 01 · 核心工具：DOM 构造、hash、点路径、节点树、patch 应用 */
(function (UK) {
  'use strict'

  function cssName(name) {
    return name.indexOf('-') >= 0 ? name : name.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase() })
  }

  UK.el = function (tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k]
        if (v == null || v === false) return
        if (k === 'class') node.className = v
        else if (k === 'text') node.textContent = v
        else if (k === 'html') node.innerHTML = v
        else if (k === 'style' && typeof v === 'object') {
          Object.keys(v).forEach(function (name) {
            if (v[name] == null || v[name] === '') return
            node.style.setProperty(cssName(name), String(v[name]))
          })
        } else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v)
        else node.setAttribute(k, v === true ? '' : v)
      })
    }
    ;[].concat(children || []).forEach(function (c) {
      if (c == null || c === false) return
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return node
  }

  UK.clone = function (v) { return JSON.parse(JSON.stringify(v)) }

  /* ── hash：与 build.mjs 完全一致 ── */

  UK.canonical = function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined }).sort()
      .map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]) }).join(',') + '}'
  }

  UK.fnv1a = function (s) {
    var h = 0x811c9dc5
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return ('0000000' + h.toString(16)).slice(-8)
  }

  UK.hashSpec = function (spec) {
    var copy = UK.clone(spec)
    delete copy.hash
    return UK.fnv1a(UK.canonical(copy))
  }

  /* ── 点路径 ── */

  UK.getPath = function (obj, path) {
    return String(path).split('.').reduce(function (cur, key) {
      return cur == null ? undefined : cur[key]
    }, obj)
  }

  UK.setPath = function (obj, path, value) {
    var keys = String(path).split('.')
    var last = keys.pop()
    var cur = obj
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
      cur = cur[k]
    }
    cur[last] = value
    return obj
  }

  /* ── 节点索引与树 ── */

  UK.index = function (spec) {
    var byId = {}
    ;(spec.nodes || []).forEach(function (n, i) { if (n && n.id) { byId[n.id] = n; n.__i = i } })
    return byId
  }

  UK.childrenOf = function (spec, id) {
    return (spec.nodes || []).filter(function (n) { return n && n.parent === id })
  }

  UK.descendantsOf = function (spec, id) {
    var out = []
    var walk = function (pid) {
      UK.childrenOf(spec, pid).forEach(function (n) { out.push(n); walk(n.id) })
    }
    walk(id)
    return out
  }

  /** 节点在屏幕坐标系里的矩形（相对画布原点） */
  UK.absRect = function (spec, node) {
    var byId = UK.index(spec)
    var x = 0, y = 0, cur = node, guard = 0
    while (cur && guard++ < 64) {
      x += cur.rect ? Number(cur.rect[0]) || 0 : 0
      y += cur.rect ? Number(cur.rect[1]) || 0 : 0
      cur = cur.parent ? byId[cur.parent] : null
    }
    return [x, y, Number(node.rect[2]) || 0, Number(node.rect[3]) || 0]
  }

  UK.depthOf = function (spec, node) {
    var byId = UK.index(spec)
    var d = 0, p = node.parent
    while (p && byId[p] && d < 64) { d++; p = byId[p].parent }
    return d
  }

  /* ── 应用 ops（只改结构的四种；extract/scope/ask 只作记录） ── */

  var STRUCT_OPS = { set: 1, add: 1, del: 1, use: 1 }

  UK.isStructOp = function (op) { return !!STRUCT_OPS[op && op.op] }

  UK.applyOps = function (baseSpec, ops) {
    var spec = UK.clone(baseSpec)
    delete spec.hash
    ;(ops || []).forEach(function (op) {
      if (!UK.isStructOp(op)) return
      var byId = UK.index(spec)
      if (op.op === 'set') {
        var target = byId[op.id]
        if (target) UK.setPath(target, op.field, UK.clone(op.value))
      } else if (op.op === 'add') {
        if (!op.node || !op.node.id || byId[op.node.id]) return
        var node = UK.clone(op.node)
        node.parent = op.parent != null ? op.parent : node.parent
        if (!node.rect) node.rect = [8, 8, 120, 40]
        if (!node.kind) node.kind = 'group'
        spec.nodes = spec.nodes || []
        spec.nodes.push(node)
      } else if (op.op === 'del') {
        var dead = {}
        dead[op.id] = 1
        UK.descendantsOf(spec, op.id).forEach(function (n) { dead[n.id] = 1 })
        spec.nodes = (spec.nodes || []).filter(function (n) { return !dead[n.id] })
      } else if (op.op === 'use') {
        var used = byId[op.node]
        if (used) {
          var deadIds = {}
          UK.childrenOf(spec, used.id).forEach(function (n) { deadIds[n.id] = 1 })
          spec.nodes = (spec.nodes || []).filter(function (n) { return !deadIds[n.id] })
          var ver = op.version == null ? '' : '@' + op.version
          used.ref = 'lib:' + op.lib + ver
          if (op.kind) used.kind = op.kind
        }
      }
    })
    return spec
  }

  UK.opLabel = function (op) {
    if (!op || !op.op) return '?'
    if (op.op === 'set') return op.id + ' · ' + op.field + ' = ' + short(op.value)
    if (op.op === 'add') return (op.node && op.node.id) + ' ↳ ' + (op.parent || 'root')
    if (op.op === 'del') return op.id
    if (op.op === 'use') return op.node + ' ← lib:' + op.lib + (op.version ? '@' + op.version : '')
    if (op.op === 'extract') return op.node + ' → ' + ((op.meta && op.meta.name) || '新条目')
    if (op.op === 'scope') return (op.ids || []).join(', ')
    if (op.op === 'ask') return op.id + ' = ' + op.answer
    return op.op
  }

  function short(v) {
    var s = typeof v === 'string' ? v : JSON.stringify(v)
    if (s == null) return String(v)
    return s.length > 46 ? s.slice(0, 43) + '…' : s
  }
  UK.short = short
})(window.__UIKIT__ = window.__UIKIT__ || {})
