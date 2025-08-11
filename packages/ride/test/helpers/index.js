export { default as MockHost } from './mockHost.js';

export const tick = () => {
  return new Promise(resolve => setTimeout(resolve, 0));
};

export const raf = () => {
  return new Promise(resolve => requestAnimationFrame(resolve));
};

export const delay = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

export const createDeferred = () => {
  const handlers = {};

  const promise = new Promise((resolve, reject) => {
    Object.assign(handlers, { resolve, reject });
  });

  return Object.assign(promise, handlers);
};
