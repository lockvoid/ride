class MockHost {
  constructor() {
    this.rootNode = { children: [], parent: null };

    this.calls = { createNode: 0, attachNode: 0, detachNode: 0, destroyNode: 0, requestRender: 0 };
  }

  createNode() {
    return {
      children: [], parent: null,
    };
  }

  attachNode(parent, node) {
    node.parent = parent;

    this.calls.attachNode++;
  }

  detachNode(parent, node) {
    node.parent = null;

    parent.children = parent.children.filter(child => child !== node);

    this.calls.detachNode++;
  }

  destroyNode(node) {
    this.calls.destroyNode++;
  }

  requestRender() {
    this.calls.requestRender++;
  }

  teardown() {
    this.rootNode = null;
  }
}

export default MockHost;
