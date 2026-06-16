const wrap = (bridge, fn, fallback) => {
  if (!bridge || typeof bridge[fn] !== 'function') return (...args) => Promise.resolve(typeof fallback === 'function' ? fallback(...args) : fallback)
  return (...args) => {
    try {
      const r = bridge[fn](...args)
      return r != null && typeof r.then === 'function' ? r : Promise.resolve(r)
    } catch (e) {
      return Promise.resolve(typeof fallback === 'function' ? fallback(...args) : fallback)
    }
  }
}

export const useBridge = () => {
  const bridge = typeof window !== 'undefined' ? window.AndroidBridge : null
  const isAvailable = bridge !== null && typeof bridge.reqPerm === 'function'

  if (!isAvailable) {
    return {
      isAvailable: false,
      requestPermission: () => Promise.resolve(false),
      takePhoto: () => Promise.resolve(""),
      getLocation: () => Promise.resolve(""),
      getDeviceInfo: () => Promise.resolve("{}"),
      startSTT: () => Promise.resolve(""),
      pickFile: () => Promise.resolve(""),
      saveFile: () => Promise.resolve(""),
      readFile: () => Promise.resolve(""),
      kvGet: () => Promise.resolve(""),
      kvSet: () => {},
      kvDel: () => {},
      getBattery: () => Promise.resolve("-1"),
      getNetwork: () => Promise.resolve("unknown"),
      getAppVersion: () => Promise.resolve("unknown"),
      vibrate: () => {},
      keepAwake: () => {},
      setClipboard: () => {},
      getClipboard: () => Promise.resolve(""),
      syncNow: () => Promise.resolve("false"),
      speakText: () => {},
      notify: () => {},
      dbGet: () => Promise.resolve(""),
      dbSet: () => {},
      dbDel: () => {},
      dbClear: () => {},
      syncEnq: () => Promise.resolve(""),
      syncStat: () => Promise.resolve('{"pending":0,"failed":0}'),
    }
  }

  return {
    isAvailable: true,
    requestPermission: wrap(bridge, 'reqPerm', () => Promise.resolve(false)),
    takePhoto: wrap(bridge, 'takePic', () => Promise.resolve("")),
    getLocation: wrap(bridge, 'getLoc', () => Promise.resolve("")),
    getDeviceInfo: wrap(bridge, 'getDev', () => Promise.resolve("{}")),
    startSTT: wrap(bridge, 'stt', () => Promise.resolve("")),
    pickFile: wrap(bridge, 'pickFile', () => Promise.resolve("")),
    saveFile: wrap(bridge, 'saveFile', () => Promise.resolve("")),
    readFile: wrap(bridge, 'readFile', () => Promise.resolve("")),
    kvGet: wrap(bridge, 'kvGet', () => Promise.resolve("")),
    kvSet: wrap(bridge, 'kvSet', () => {}),
    kvDel: wrap(bridge, 'kvDel', () => {}),
    getBattery: wrap(bridge, 'getBat', () => Promise.resolve("-1")),
    getNetwork: wrap(bridge, 'getNet', () => Promise.resolve("unknown")),
    getAppVersion: wrap(bridge, 'getVer', () => Promise.resolve("unknown")),
    vibrate: wrap(bridge, 'vibrate', () => {}),
    keepAwake: wrap(bridge, 'keepAwake', () => {}),
    setClipboard: wrap(bridge, 'setClip', () => {}),
    getClipboard: wrap(bridge, 'getClip', () => Promise.resolve("")),
    syncNow: wrap(bridge, 'syncNow', () => Promise.resolve("false")),
    speakText: wrap(bridge, 'speak', () => {}),
    notify: wrap(bridge, 'notify', () => {}),
    dbGet: wrap(bridge, 'dbGet', () => Promise.resolve("")),
    dbSet: wrap(bridge, 'dbSet', () => {}),
    dbDel: wrap(bridge, 'dbDel', () => {}),
    dbClear: wrap(bridge, 'dbClear', () => {}),
    syncEnq: wrap(bridge, 'syncEnq', () => Promise.resolve("")),
    syncStat: wrap(bridge, 'syncStat', () => Promise.resolve('{"pending":0,"failed":0}')),
  }
}
