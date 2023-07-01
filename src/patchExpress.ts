/**
* Fix Promises catch to express send correct error to client and dont crash server
*/
import expressLayer from "express/lib/router/layer.js";
expressLayer.prototype.handle_request = async function handle_request_promised(...args) {
  var fn = this.handle;
  if (fn.length > 3) return args.at(-1)();
  try {
    await fn(...args);
  } catch (err) {
    args.at(-1)(err);
  }
}