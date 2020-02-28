'use strict'

const HomeKitGenericService = require('./HomeKitGenericService.js').HomeKitGenericService

class HomeMaticHomeKitBlindService extends HomeKitGenericService {
  createDeviceService (Service, Characteristic) {
    let self = this
    var blind = this.getService(Service.WindowCovering)
    this.delayOnSet = 750
    this.observeInhibit = this.getClazzConfigValue('observeInhibit', false)
    this.inhibit = false
    this.minValueForClose = this.getClazzConfigValue('minValueForClose', 0)
    this.maxValueForOpen = this.getClazzConfigValue('maxValueForOpen', 100)
    this.ignoreWorking = true
    this.currentLevel = 0
    this.targetLevel = undefined
    this.isWorking = false

    if (this.minValueForClose > 0) {
      this.log.debug('[BLIND] there is a custom closed level of %s', this.minValueForClose)
    }

    if (this.maxValueForOpen < 100) {
      this.log.debug('[BLIND] there is a custom open level of %s', this.maxValueForOpen)
    }

    this.currentPos = blind.getCharacteristic(Characteristic.CurrentPosition)
      .on('get', (callback) => {
        self.query('LEVEL', (value) => {
          value = self.processBlindLevel(value)
          self.log.debug('[BLIND] getCurrent Position %s', value)
          if (callback) callback(null, value)
        })
      })

    this.currentPos.eventEnabled = true

    this.targetPos = blind.getCharacteristic(Characteristic.TargetPosition)
      .on('get', (callback) => {
        self.query('LEVEL', (value) => {
          value = self.processBlindLevel(value)
          if (callback) {
            self.log.debug('[BLIND] return %s as TargetPosition', value)
            callback(null, value)
          }
        })
      })
      .on('set', (value, callback) => {
        // if obstruction has been detected
        if ((self.observeInhibit === true) && (self.inhibit === true)) {
          // wait one second to resync data
          self.log.debug('[BLIND] inhibit is true wait to resync')
          clearTimeout(self.timer)
          self.timer = setTimeout(() => {
            self.queryData()
          }, 1000)
        } else {
          self.targetLevel = value
          self.eventupdate = false // whaat?
          self.delayed('set', 'LEVEL', (parseFloat(value) / 100), self.delayOnSet)
        }
        callback()
      })

    this.pstate = blind.getCharacteristic(Characteristic.PositionState)
      .on('get', (callback) => {
        self.query('DIRECTION', (value) => {
          if (callback) {
            var result = 2
            if (value !== undefined) {
              switch (value) {
                case 0:
                  result = 2 // Characteristic.PositionState.STOPPED
                  break
                case 1:
                  result = 0 // Characteristic.PositionState.DECREASING
                  break
                case 2:
                  result = 1 // Characteristic.PositionState.INCREASING
                  break
                case 3:
                  result = 2 // Characteristic.PositionState.STOPPED
                  break
              }
              callback(null, result)
            } else {
              callback(null, '0')
            }
          }
        })
      })

    // this.pstate.eventEnabled = true

    // only add if ObstructionDetected is used
    if (this.observeInhibit === true) {
      this.obstruction = blind.getCharacteristic(Characteristic.ObstructionDetected)
        .on('get', (callback) => {
          callback(null, this.inhibit)
        })
      this.obstruction.eventEnabled = true
      this.platform.registeraddressForEventProcessingAtAccessory(this.buildHomeMaticAddress('INHIBIT'), this, function (newValue) {
        self.inhibit = self.isTrue(newValue)
        if (self.obstruction !== undefined) {
          self.obstruction.updateValue(self.isTrue(newValue), null)
        }
      })
    }

    this.platform.registeraddressForEventProcessingAtAccessory(this.buildHomeMaticAddress('DIRECTION'), this, function (newValue) {
      self.updatePosition(parseInt(newValue))
    })

    this.platform.registeraddressForEventProcessingAtAccessory(this.buildHomeMaticAddress('LEVEL'), this, function (newValue) {
      if (self.isWorking === false) {
        self.log.debug('[BLIND] set final HomeKitValue to %s', newValue)
        self.setFinalBlindLevel(newValue)
      } else {
        let lvl = self.processBlindLevel(newValue)
        self.log.debug('[BLIND] set HomeKitValue to %s', lvl)
        self.currentLevel = lvl
        self.currentPos.updateValue(self.currentLevel, null)
      }
    })

    this.platform.registeraddressForEventProcessingAtAccessory(this.buildHomeMaticAddress('WORKING'), this, function (newValue) {
      // Working false will trigger a new remote query
      if (!self.isTrue(newValue)) {
        self.isWorking = false
        self.removeCache('LEVEL')
        self.remoteGetValue('LEVEL')
      } else {
        self.isWorking = true
      }
    })

    this.deviceaddress = this.address.slice(0, this.address.indexOf(':'))
    this.queryData()
  }

  queryData (value) {
    // trigger new event (datapointEvent)
    // kill the cache first
    let self = this
    this.removeCache('LEVEL')
    this.remoteGetValue('LEVEL', (value) => {
      value = self.processBlindLevel(value)
      self.currentPos.updateValue(value, null)
      self.targetPos.updateValue(value, null)
      self.targetLevel = undefined
    })

    if (this.observeInhibit === true) {
      this.query('INHIBIT', (value) => {
        self.updateObstruction(self.isTrue(value)) // not sure why value (true/false) is currently a string? - but lets convert it if it is
      })
    }
  }

  processBlindLevel (newValue) {
    var value = parseFloat(newValue)
    value = value * 100
    if (value < this.minValueForClose) {
      value = 0
    }
    if (value > this.maxValueForOpen) {
      value = 100
    }
    this.log.debug('[BLIND] processLevel (%s) min (%s) max (%s) r (%s)', newValue, this.minValueForClose, this.maxValueForOpen, value)
    return value
  }

  // https://github.com/thkl/homebridge-homematic/issues/208
  // if there is a custom close level and the real level is below homekit will get the 0% ... and visevera for max level

  setFinalBlindLevel (value) {
    value = this.processBlindLevel(value)
    this.currentPos.updateValue(value, null)
    this.targetPos.updateValue(value, null)
    this.targetLevel = undefined
    this.pstate.updateValue(2, null) // STOPPED
  }

  updatePosition (value) {
    // 0 = NONE (Standard)
    // 1=UP
    // 2=DOWN
    // 3=UNDEFINED
    switch (value) {
      case 0:
        this.pstate.updateValue(2, null)
        break
      case 1: // opening - INCREASING
        this.pstate.updateValue(1, null)
        // set target position to maximum, since we don't know when it stops
        this.guessTargetPosition(100)
        break
      case 2: // closing - DECREASING
        this.pstate.updateValue(0, null)
        // same for closing
        this.guessTargetPosition(0)
        break
      case 3:
        this.pstate.updateValue(2, null)
        break
    }
  }

  guessTargetPosition (value) {
    // Only update Target position if it has not been set via homekit (see targetPos.on('set'))
    if (this.targetLevel === undefined) {
      this.targetPos.updateValue(value, null)
    }
  }

  updateObstruction (value) {
    this.inhibit = value
    this.obstruction.updateValue(value, null)
  }

  shutdown () {
    this.log.debug('[BLIND] shutdown')
    super.shutdown()
    clearTimeout(this.timer)
  }
}
module.exports = HomeMaticHomeKitBlindService
