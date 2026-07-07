export class WindowsService {
  static obtainWindow(name) {
    return new Promise((resolve, reject) => {
      overwolf.windows.obtainDeclaredWindow(name, result => {
        if (result.success) {
          resolve(result);
        } else {
          console.warn('WindowsService.obtainWindow() error:', name, result);
          reject(new Error(result.error));
        }
      });
    });
  }

  static async restore(name) {
    const { window } = await WindowsService.obtainWindow(name);
    return new Promise((resolve, reject) => {
      overwolf.windows.restore(window.id, result => {
        if (result.success) {
          resolve(window.id);
        } else {
          console.warn('WindowsService.restore() error:', name, result);
          reject(new Error(result.error));
        }
      });
    });
  }

  static async close(name) {
    try {
      const { window } = await WindowsService.obtainWindow(name);
      return new Promise(resolve => overwolf.windows.close(window.id, resolve));
    } catch (e) {
      console.warn('WindowsService.close() error:', name, e);
    }
  }

  static async minimize(name) {
    const { window } = await WindowsService.obtainWindow(name);
    return new Promise((resolve, reject) => {
      overwolf.windows.minimize(window.id, result => {
        if (result.success) {
          resolve();
        } else {
          reject(new Error(result.error));
        }
      });
    });
  }

  static async changePosition(name, left, top) {
    const { window } = await WindowsService.obtainWindow(name);
    return new Promise((resolve, reject) => {
      overwolf.windows.changePosition(window.id, left, top, result => {
        if (result && result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error));
        }
      });
    });
  }

  static async changeSize(name, width, height) {
    const { window } = await WindowsService.obtainWindow(name);
    return new Promise((resolve, reject) => {
      overwolf.windows.changeSize(window.id, width, height, result => {
        if (result && result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error));
        }
      });
    });
  }

  static async setTopmost(name, shouldBeTopmost) {
    const { window } = await WindowsService.obtainWindow(name);
    return new Promise((resolve, reject) => {
      overwolf.windows.setTopmost(window.id, shouldBeTopmost, result => {
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error));
        }
      });
    });
  }

  static async getWindowState(name) {
    const { window } = await WindowsService.obtainWindow(name);
    return new Promise((resolve, reject) => {
      overwolf.windows.getWindowState(window.id, result => {
        if (result.success) {
          resolve(result.window_state);
        } else {
          reject(new Error(result.error));
        }
      });
    });
  }
}
