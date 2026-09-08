import { supplierForRoute } from "./detect.js";

/** 将探测到的全部路由与静态已知路由统一归属。 */
export function createRouteResolver() {
  let detected = {};
  return {
    update(routes) { detected = { ...routes }; },
    resolve(route) {
      return typeof route === "string" && Object.hasOwn(detected, route)
        ? detected[route] : supplierForRoute(route);
    },
  };
}
