/* test rig */ var t = 1, tmax = 2
function ok (a, d) { console.log(a ? 'ok ' + (t++) + ' -' : 'not ok ' + (t++) + ' -', d); }
console.log(t + '..' + tmax);
ok(process.versions.colony, 'running in colony')

setTimeout(function () {
  ok(this == global, '"this" value in timer is global object');
  ok(true, 'console.log of global works #TODO');
  // console.log(this)
}, 10);

var id = setInterval(function () {
  ok(false, 'error, interval was not cancelled');
  process.exit(1);
}, 100)
clearInterval(id);

console.log('# timeout id:', id)

var count = 0;
var jk = setInterval(function () {
	count++;
	clearInterval(jk);
	if (count > 1) {
		ok(false, 'error, interval was not cancelled from inside interval')
		process.exit(1)
	}
}, 0)

setImmediate(function (arg1, arg2, arg3) {
	ok(arg1 != null, 'args passed into callback');
	ok(arg2 == null, 'null args allowed in callback');
	ok(arg3 != null, 'null args allowed in callback');
}, 5, null, 6)