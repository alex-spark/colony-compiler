#!/usr/bin/env node

var fs = require('fs')
  , falafel = require('falafel')
  , colors = require('colors')
  , path = require('path');

/**
 * Arguments
 */

var argv = require('optimist')
  .usage('Compile JavaScript to Lua.\nUsage: $0 file1 [file2 file3...]')
  .alias('b', 'bundle').boolean('b').describe('b', 'Concatenate library and source files.')
  .alias('c', 'compile').boolean('c').describe('c', 'Compile code to lua and output.')
  .demand(1)
  .argv;

var flagconcat = argv.b || !argv.c;


/** 
 * Colonize
 */

var keywords = ['end', 'do', 'nil', 'error'];
var mask = ['string', 'math', 'print', 'type', 'pairs'];

function fixIdentifiers (str) {
  if (keywords.indexOf(str) > -1) {
    return '_K_' + str;
  }
  return str.replace(/_/g, '__').replace(/\$/g, '_S');
}

function uniqueStrings (arr) {
  var o = {};
  arr.forEach(function (k) {
    o[k] = true;
  });
  return Object.keys(o);
}

function attachIdentifierToContext (id, node) {
  var name = fixIdentifiers(id.source());
  while (node = node.parent) {
    if (node.type == 'FunctionDeclaration' || node.type == 'Program' || node.type == 'FunctionExpression') {
      (node.identifiers || (node.identifiers = [])).push(name);
      node.identifiers = uniqueStrings(node.identifiers);
      return;
    }
  }
}

function truthy (node) {
  if (['!', '<', '<=', '>', '>=', '===', '!=', '!==', 'instanceof', 'in'].indexOf(node.operator) == -1) {
    node.update("_truthy(" + node.source() + ")");
  }
  return node.source();
}

function colonizeContext (ids, node) {
  if (ids) {
    ids = ids.filter(function (id) {
      return id != 'arguments';
    });
  }
  node.update([
    // Variables
    ids && ids.length ? 'local ' + ids.join(', ') + ' = ' + ids.join(', ') + ';' : '',
    // Hoist Functions
    node.body.filter(function (stat) {
      return stat.type == 'FunctionDeclaration';
    }).map(function (stat) {
      return stat.source();
    }).join('\n'),
    // Statements
    node.body.filter(function (stat) {
      return stat.type != 'FunctionDeclaration';
    }).map(function (stat) {
      return stat.source();
    }).join('\n')
  ].filter(function (n) {
    return n;
  }).join('\n'));
}

function getLoops (node) {
  var loops = [];
  var par = node;
  while (par = par.parent) {
    if (par.type == 'WhileStatement' || par.type == 'ForStatement' || par.type == 'TryStatement') {
      var parname = par.parent.type == 'LabeledStatement' ? par.parent.label.source() :'';
      loops.unshift([par.type, parname, node.usesContinue]);
    }
  }
  return loops;
}

var labels = [];
var loops = [];

function colonize (node) {
  // console.error(node.type);
  // console.error(process.memoryUsage().heapUsed/1024);

  switch (node.type) {
    case 'Identifier':
      if (node.source() == 'arguments' && node.parent.type != 'Property') {
        attachIdentifierToContext(node, node);
      }
      if (node.parent.type != 'MemberExpression') {
        node.update(fixIdentifiers(node.source()));
      }
      break;

    case 'AssignmentExpression':
      // +=, -=, etc.
      if (node.operator != '=') {
        if (node.operator == '|=') {
          node.right.update('_bit.bor(' + node.left.source() + ', ' + node.right.source() + ')');
        } else {
          node.right.update(node.left.source() + ' ' + node.operator.substr(0, 1) + ' ' + node.right.source());
        }
        node.operator = '=';
      }
      // Used in another expression, assignments must be wrapped by a closure.
      if (node.parent.type != 'ExpressionStatement') {
        node.update('(function () local _r = ' + node.right.source() + '; ' + node.left.source() + ' = _r; return _r; end)()');
      } else {
        // Need to refresh thanks to += updating.
        node.update(node.left.source() + ' = ' + node.right.source());
      }
      break;

    case 'EmptyStatement':
      node.source('');
      break;

    case 'ThisExpression':
      break;  

    case 'UnaryExpression':
      if (node.operator == '~') {
        node.update('_bit.bnot(' + node.argument.source() + ')');
      } else if (node.operator == '!') {
        node.update('(not (' + node.argument.source() + '))');
      } else if (node.operator == 'typeof') {
        node.update('_typeof(' + node.argument.source() + ')');
      } else if (node.operator == 'delete') {
        // TODO return true/false
        node.update(node.argument.source() + ' = nil');
      } else {
        node.update('(' + node.source() + ')');
      }
      break;

    case 'BinaryExpression':
      if (node.operator == '!==' || node.operator == '!=') {
        // TODO strict
        node.update('(' + node.left.source() + ' ~= ' + node.right.source() + ')');
      } else if (node.operator == '===') {
        // TODO strict
        node.update('(' + node.left.source() + ' == ' + node.right.source() + ')');
      } else if (node.operator == '<<') {
        node.update('_bit.lshift(' + node.left.source() + ', ' + node.right.source() + ')');
      } else if (node.operator == '>>') {
        node.update('_bit.rshift(' + node.left.source() + ', ' + node.right.source() + ')');
      } else if (node.operator == '&') {
        node.update('_bit.band(' + node.left.source() + ', ' + node.right.source() + ')');
      } else if (node.operator == '|') {
        node.update('_bit.bor(' + node.left.source() + ', ' + node.right.source() + ')');
      } else if (node.operator == 'instanceof') {
        node.update('_instanceof(' + node.left.source() + ', ' + node.right.source() + ')');
      } else {
        node.update('(' + node.source() + ')');
      }
      break;

    case 'LogicalExpression':
      if (node.operator == '&&') {
        node.update(node.left.source() + ' and ' + node.right.source());
      } else if (node.operator == '||') {
        node.update(node.left.source() + ' or ' + node.right.source());
      }
      break;

    case 'UpdateExpression':
      // ++ or --
      if (node.prefix) {
        node.update('(function () ' + node.argument.source() + ' = ' + node.argument.source() + ' ' + node.operator.substr(0, 1) + ' 1; return ' + node.argument.source() + '; end)()');
      } else {
        node.update('(function () local _r = ' + node.argument.source() + '; ' + node.argument.source() + ' = _r ' + node.operator.substr(0, 1) + ' 1; return _r end)()');
      }
      break;

    case 'NewExpression':
      node.update("_new(" +
        [node.callee.source()].concat(node.arguments.map(function (arg) {
          return arg.source();
        })).join(', ') + ")");
      break;

    case 'VariableDeclarator':
      attachIdentifierToContext(node.id, node);
      break;

    case 'VariableDeclaration':
      node.update(node.declarations.map(function (d) {
        return d.id.source();
      }).join(', ') + ' = ' + node.declarations.map(function (d) {
        return d.init ? d.init.source() : 'nil'
      }).join(', ') + ';');
      break;

    case 'BreakStatement':
      //TODO _c down the stack is false until the main one
      //label = label or (x for x in loops when loops[0] != 'try')[-1..][0]?[1] or ""

      var label = node.label ? node.label.source() : '';

      node.update("_c" + label + " = _break; " +
        ((getLoops(node).slice(-1)[0] || [])[0] == "TryStatement" ? "return _break;" : "break;"));
      break;

    case 'SwitchCase':
      break;
    case 'SwitchStatement':
      node.update([
        'repeat',
        node.cases.map(function (c, i) {
          return 'local _' + i + (c.test ? ' = ' + c.test.source() : '') + ';'
        }).join(' '),
        'local _r = ' + node.discriminant.source() + ';',
        node.cases.map(function (c, i) {
          if (!c.test) {
            return c.consequent.map(function (s) {
              return s.source();
            }).join('\n')
          }
          return 'if _r == _' + i + ' then\n' + c.consequent.map(function (s) {
            return s.source();
          }).join('\n') + '\n' + (i < node.cases.length - 1 && (c.consequent.slice(-1)[0] || {}).type != 'BreakStatement' ? '_r = _' + (i + 1) + ';\n' : '') + 'end'
        }).join('\n'),
        'until true'
      ].join('\n'))
// ret = "repeat\n" +
//   (if cases.length then ("local _#{i}#{if v then ' = ' + colonize(v) else ''}; " for i, [v, _] of cases).join('') else '') +
//   "local _r = #{colonize(expr)};\n" +
//   (for i, [_, stats] of cases
//     if _?
//       "if _r == _#{i} then\n" + (colonize(x) for x in stats).concat(if cases[Number(i)+1] and (not stats.length or stats[-1..][0].type != "break-stat") then ["_r = _#{Number(i)+1};"] else []).join("\n") + "\nend"
//     else
//       (colonize(x) for x in stats).join("\n")
//   ).join("\n") + "\n" +
//   "until true"
// loops.pop()
      break;


    case 'ContinueStatement':
      //TODO _c down the stack is false until the main one
      //label = label or (x for x in loops when loops[0] != 'try')[-1..][0]?[1] or ""

      var label = node.label ? node.label.source() : '';

      var par = node;
      while (par = par.parent) {
        if (par.type == 'WhileStatement' || par.type == 'ForStatement') {
          par.usesContinue = true;
        }
      }
      node.update("_c" + label + " = _cont; " +
        ((getLoops(node).slice(-1)[0] || [])[0] == "TryStatement" ? "return _cont;" : "break;"));
      break;

    case 'DoWhileStatement':
      var name = node.parent.type == 'LabeledStatement' ? node.parent.label.source() :'';

      var loops = getLoops(node);
      var ascend = loops.filter(function (l) {
        return l[0] != 'TryStatement' && l[1] != null;
      }).map(function (l) {
        return l[1];
      });

      node.update([
        'repeat',
        (node.usesContinue ? 'local _c' + name + ' = nil; repeat' : ''),
        node.body.source(),
        (node.usesContinue ? 'until true;\nif _c' + name + ' == _break' + [''].concat(ascend).join(' or _c') + ' then break end' : ''),
        'until not ' + truthy(node.test) + ';'
      ].join('\n'))
      break;

    case 'WhileStatement':
      var name = node.parent.type == 'LabeledStatement' ? node.parent.label.source() :'';

      var loops = getLoops(node);
      var ascend = loops.filter(function (l) {
        return l[0] != 'TryStatement' && l[1] != null;
      }).map(function (l) {
        return l[1];
      });

      node.update([
        'while ' + truthy(node.test) + ' do',
        (node.usesContinue ? 'local _c' + name + ' = nil; repeat' : ''),
        node.body.source(),
        (node.usesContinue ? 'until true;\nif _c' + name + ' == _break' + [''].concat(ascend).join(' or _c') + ' then break end' : ''),
        'end'
      ].join('\n'))
      break;

    case 'ForStatement':
      node.update([
        node.init ? node.init.source() : '',
        'while ' + (node.test ? truthy(node.test) : 'true') + ' do',
        (node.usesContinue ? 'local _c = nil; repeat' : ''),
        node.body.source(),
        (node.usesContinue ? 'until true;\nif _c == _break then break end' : ''),
        node.update ? node.update.source() : '',
        'end'
      ].join('\n'))
      break;

    case 'Literal':
      if (node.value instanceof RegExp) {
        node.update('RegExp(' + JSON.stringify(node.value.source) + ', ' + JSON.stringify(String(node.value).replace(/^.*\//, '')) + ')');
      } else if (typeof node.value == 'string') {
        // TODO update
        node.update('(' + JSON.stringify(node.value).replace(/\\u00/, '\\x') + ')');
      } else if (node.parent.type != 'Property') {
        node.update('(' + JSON.stringify(node.value) + ')');
      }
      break;

    case 'CallExpression':
      if (node.callee.type == 'MemberExpression') {
        // Method call
        if (node.callee.property.type == 'Identifier' && fixIdentifiers(node.callee.property.name) != node.callee.property.name) {
          // Escape keywords awkwardly.
          node.update("(function () local base, prop = " + node.callee.object.source() + ', '
            + (node.callee.property.type == 'Identifier' ? JSON.stringify(node.callee.property.source()) : node.callee.property.source())
            + '; return base[prop]('
            + ['base'].concat(node.arguments.map(function (arg) {
              return arg.source()
            })).join(', ') + '); end)()');
        } else {
          node.update(node.callee.object.source() + ':'
            + node.callee.property.source()
            // + '[' + (node.callee.property.type == 'Identifier' ? JSON.stringify(node.callee.property.source()) : node.callee.property.source()) + ']'
            + '(' + node.arguments.map(function (arg) {
            return arg.source()
          }).join(', ') + ')')
        }
      } else {
        node.update(node.callee.source() + '(' + ['global'].concat(node.arguments.map(function (arg) {
          return arg.source()
        })).join(', ') + ')')
      }
      break;

    case 'ObjectExpression':
      node.update('_obj({\n  ' +
        node.properties.map(function (prop) {
          return '[' + JSON.stringify(prop.key.type == 'Identifier' ? prop.key.name : prop.key.value) + ']=' + prop.value.source()
        }).join(',\n  ') +
        '})');
      break;
    case 'Property':
      break;

    case 'ArrayExpression':
      if (!node.elements.length) {
        node.update("_arr({})");
      } else {
        node.update("_arr({[0]=" + [].concat(node.elements.map(function (el) {
          return el.source();
        })).join(', ') + "})");
      }
      break;

    case 'ConditionalExpression':
      node.update('(' + truthy(node.test) + ' and {' + node.consequent.source() + '} or {' + node.alternate.source() + '})[1]');
      break;

    case 'IfStatement':
      node.update([
        "if " + truthy(node.test) + " then\n",
        node.consequent.source() + '\n',
        (node.alternate ? 'else\n' + node.alternate.source() + '\n' : ""),
        "end"
      ].join(''));
      break;

    case 'ReturnStatement':
      // Wrap in conditional to allow returns to precede statements
      node.update("if true then return" + (node.argument ? ' ' + node.argument.source() : '') + "; end;");
      break;

    case 'BlockStatement':
      colonizeContext(node.parent.type == 'FunctionDeclaration' || node.parent.type == 'FunctionExpression' ? node.parent.identifiers : [], node);
      break;

    case 'MemberExpression':
      if (node.parent.type != 'CallExpression') {
        node.update("(" + node.object.source() + ")"
          + '[' + (!node.computed ? JSON.stringify(node.property.source()) : node.property.source()) + ']');
      }
      break;

    case 'ExpressionStatement':
      node.update(node.source().replace(/;?$/, ';')); // Enforce trailing semicolons.

      // Can't have and/or be statements.
      if (node.expression.type == 'BinaryExpression' || node.expression.type == 'LogicalExpression' || node.expression.type == 'Literal' || node.expression.type == 'CallExpression') {
        node.update('if ' + node.source().replace(/;?$/, '') + ' then end;');
      }
      break;

    case 'LabeledStatement':
      // TODO change stat to do { } while(false) unless of certain type;
      // this makes this labels array work
      node.update(node.body.source());
      break;

    case 'ForInStatement':
      if (node.left.type == 'VariableDeclaration') {
        var name = fixIdentifiers(node.left.declarations[0].id.name);
      } else {
        var name = node.left.source();
      }
      node.update([
        'for ' + name + ' in _pairs(' + node.right.source() + ') do',
        node.body.source(),
        'end'
      ].join('\n'))
      break;

    case 'ThrowStatement':
      node.update("_error(" + node.argument.source() + ")");
      break;

    case 'CatchClause':
      break;

    case 'TryStatement':
      node.update([
'local _e = nil',
'local _s, _r = _xpcall(function ()',
node.block.source(),
//    #{if tryStat.stats[-1..][0].type != 'ret-stat' then "return _cont" else ""}
'    end, function (err)',
'        _e = err',
'    end)',

// catch clause
'if _s == false then',
node.handlers[0].param.source() + ' = _e;\n' + node.handlers[0].body.source(),

// break clause.
'end',
node.finalizer ? node.finalizer.source() : ''
].concat(
!getLoops(node).length ? [] : [
//break
'if _r == _break then',
(getLoops(node).length && getLoops(node).slice(-1)[0][0] == 'TryStatement' ? 'return _break;' : 'break;'),
// continue clause.
'elseif _r == _cont then',
//'  return _r',
(getLoops(node).length && getLoops(node).slice(-1)[0][0] == 'TryStatement' ? 'return _cont;' : 'break;'),
'end'
      ]).join('\n'));
      break;

    case 'FunctionExpression':
    case 'FunctionDeclaration':
      if (node.id && !node.expression) {
        attachIdentifierToContext(node.id, node);
      }

      node.identifiers || (node.identifiers = []);

      // fix references
      var name = node.id && node.id.source();
      var args = node.params.map(function (arg) {
        return arg.source();
      });

      // expression prefix/suffix
      if (!node.expression && node.parent.type != 'CallExpression' && name) {
        // TODO among other types of expressions...
        var prefix = name + ' = ', suffix = ';';
      } else {
        var prefix = '', suffix = '';
      }

      // assign self-named function reference
      var namestr = "";
      if (name) {
        namestr = "local " + name + " = _debug.getinfo(1, 'f').func;\n";
      }

      var loopsbkp = loops;
      var loops = [];
      if (node.identifiers.indexOf('arguments') > -1) {
        node.update(prefix + "_func(function (this, ...)\n" + namestr +
          "local arguments = _arguments(...);\n" +
          (args.length ? "local " + args.join(', ') + " = ...;\n" : "") +
          node.body.source() + "\n" +
          "end)" + suffix);
      } else {
        node.update(prefix + "_func(function (" + ['this'].concat(args).join(', ') + ")\n" + namestr +
          node.body.source() + "\n" +
          "end)" + suffix);
      }

      loops = loopsbkp;
      break;

    case 'Program':
      colonizeContext(node.identifiers, node);
      node.update([
        "function (_ENV)",
        'local ' + mask.join(', ') + ' = ' + mask.map(function () { return 'nil'; }).join(', ') + ';',
        "local _module = {exports={}}; local exports, module = _module.exports, _module;",
        "",
        node.source(),
        "",
        "return _module.exports;",
        "end"
      ].join('\n'));
      break;

    default:
      console.log(node.type.red, node);
  }
}

function colonizeModule (src) {
  var lua = String(falafel(src, colonize))
    .replace(/^(.*?)\/\//gm, '$1--')
    .replace(/\/\*([\S\s]*?)\*\//, '')
    .replace(/^\s+|\s+$/g, '');
  if (flagconcat) {
    return 'local colony = (function ()\n' + fs.readFileSync(path.join(__dirname, '../lib/colony.lua')) + '\nend)()\n\nreturn colony.run(' + lua + ')'
  } else {
    return 'return ' + lua;
  }
}


/**
 * Output
 */

function go (src) {
  try {
    src = (src || '') + '\n' + argv._.filter(function (f) {
      return f != '-';
    }).map(function (file) {
      if (!fs.existsSync(file) && fs.existsSync(file + '.js')) {
        file = file + '.js';
      }
      return fs.readFileSync(file, 'utf-8');
    }).join('\n\n');

    var luacode = colonizeModule(src);
  } catch (e) {
    console.error(String(e.stack).red);
    process.exit(100);
  }

  if (argv.c) {
    // Output source code
    console.log(luacode);
  } else {
    var lua = require('child_process').spawn('lua', ['-e', luacode]);
    process.stdin.pipe(lua.stdin);
    lua.stdout.on('data', function (str) {
      process.stdout.write(String(str).green);
    });
    lua.stderr.on('data', function (str) {
      process.stderr.write(String(str).yellow);
    });
    lua.on('close', function (code) {
      process.exit(code);
    });
  }
}

if (argv._.indexOf('-') > -1) {
  process.stdin.setEncoding('utf-8');
  var inin = '';
  process.stdin.on('data', function (str) {
    inin += str;
  })
  process.stdin.on('close', function () {
    go(inin);
  });
} else {
  go('');
}