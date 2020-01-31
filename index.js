/* jshint node: true */
"use strict";
var Service;
var Characteristic;
var DoorState;
var Gpio = require('onoff').Gpio;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    DoorState = homebridge.hap.Characteristic.CurrentDoorState;

    homebridge.registerAccessory("homebridge-rasppi-gpio-garagedoor", "RaspPiGPIOGarageDoor", RaspPiGPIOGarageDoorAccessory);
};

function getVal(config, key, defaultVal) {
    var val = config[key];
    if (val === null) {
        return defaultVal;
    }
    return val;
}

function doorStateToString(state) {
    switch (state) {
      case DoorState.OPEN:
        return "OPEN";
      case DoorState.CLOSED:
        return "CLOSED";
      case DoorState.STOPPED:
        return "STOPPED";
      default:
        return "UNKNOWN";
    }
}

function RaspPiGPIOGarageDoorAccessory(log, config) {
    this.log = log;
    this.version = require('./package.json').version;
    log("RaspPiGPIOGarageDoorAccessory version " + this.version);
  
    if (!Gpio.accessible) {
        log("WARN! WARN! WARN! may not be able to control GPIO pins!");
    }

    this.name = config.name;
    this.doorSwitchPin = config.doorSwitchPin;
    this.relayOn = getVal(config, "doorSwitchValue", 1);
    this.relayOff = 1-this.relayOn; //opposite of relayOn (O/1)
    this.doorSwitchPressTimeInMs = getVal(config, "doorSwitchPressTimeInMs", 1000);
    this.closedDoorSensorPin = config.closedDoorSensorPin;
    this.openDoorSensorPin = config.openDoorSensorPin;
    this.doorOpensInSeconds = config.doorOpensInSeconds;
    this.closedDoorSensorValue = getVal(config, "closedDoorSensorValue", 1);
    this.openDoorSensorValue = getVal(config, "openDoorSensorValue", 1);
    log("Door Switch Pin: " + this.doorSwitchPin);
    log("Door Switch Val: " + (this.relayOn == 1 ? "ACTIVE_HIGH" : "ACTIVE_LOW"));
    log("Door Switch Active Time in ms: " + this.doorSwitchPressTimeInMs);
    log("Door Closed Sensor Pin: " + this.closedDoorSensorPin);
    log("Door Closed Sensor Val: " + (this.closedDoorSensorValue == 1 ? "ACTIVE_HIGH" : "ACTIVE_LOW"));
    log("Door Open Sensor Pin: " + this.openDoorSensorPin);
    log("Door Open Sensor Val: " + (this.openDoorSensorValue == 1 ? "ACTIVE_HIGH" : "ACTIVE_LOW"));
    log("Door Opens in seconds: " + this.doorOpensInSeconds);
    this.initService();
}

RaspPiGPIOGarageDoorAccessory.prototype = {

    initService: function() {
        this.garageDoorOpener = new Service.GarageDoorOpener(this.name,this.name);
        this.currentDoorState = this.garageDoorOpener.getCharacteristic(DoorState);
        this.currentDoorState.on('get', this.getState.bind(this));
        this.targetDoorState = this.garageDoorOpener.getCharacteristic(Characteristic.TargetDoorState);
        this.targetDoorState.on('set', this.setState.bind(this));
        this.targetDoorState.on('get', this.getTargetState.bind(this));
        this.obstructionDetected = this.garageDoorOpener.getCharacteristic(Characteristic.ObstructionDetected);
        this.obstructionDetected.on('get', this.getObstructionState.bind(this));
    
        this.infoService = new Service.AccessoryInformation();
        this.infoService
            .setCharacteristic(Characteristic.Manufacturer, "Opensource Community")
            .setCharacteristic(Characteristic.Model, "RaspPi GPIO GarageDoor")
            .setCharacteristic(Characteristic.SerialNumber, "Version 1.0.0");
        
        this.doorButton = new Gpio(this.doorSwitchPin, this.relayOff ? 'high' : 'low');
        this.closedDoorSensor = new Gpio(this.closedDoorSensorPin, 'in', 'both', {debounceTimeout: 100});
        this.openDoorSensor = new Gpio(this.openDoorSensorPin, 'in', 'both', {debounceTimeout: 100});
       
        var initialDoorState = DoorState.STOPPED;
        this.operating = false;
        if (this.isClosed()) initialDoorState = DoorState.CLOSED;
        if (this.isOpen()) initialDoorState = DoorState.OPEN;
        this.log("Initial Door State: " + doorStateToString(initialDoorState));
        this.currentDoorState.updateValue(initialDoorState);
        this.targetDoorState.updateValue(initialDoorState);
        this.targetState = initialDoorState;
        this.isSoftwareSwitch = false;
    
        var that = this;
        this.closedDoorSensor.watch(function (err, value) { //Watch for hardware interrupts
            if (err) {
                that.error('There was an error', err);
                that.currentDoorState.updateValue(DoorState.STOPPED);
            }
            if (value == that.closedDoorSensorValue) {
                that.log("door is closed");
                that.currentDoorState.updateValue(DoorState.CLOSED);
                that.operating = false;
            } else {
                if (!that.isSoftwareSwitch && that.currentDoorState.value == DoorState.CLOSED) {
                    that.log("door is opening manually");
                    that.currentDoorState.updateValue(DoorState.OPENING);
                    that.targetState = DoorState.OPEN;
                    that.targetDoorState.updateValue(DoorState.OPEN);
                    if (!that.operating) {
                        setTimeout(that.setFinalDoorState.bind(that), that.doorOpensInSeconds * 1000);
                        that.operating = true;
                    }
                }
            }
        });
        
        this.openDoorSensor.watch(function (err, value) { //Watch for hardware interrupts
            if (err) {
                that.error('There was an error', err);
                that.currentDoorState.updateValue(DoorState.STOPPED);
            }
            if (value == that.openDoorSensorValue) {
                that.log("door is open");
                that.currentDoorState.updateValue(DoorState.OPEN);
                that.operating = false;
            } else {
                if (!that.isSoftwareSwitch && that.currentDoorState.value == DoorState.OPEN) {
                    that.log("door is closing manually");
                    that.currentDoorState.updateValue(DoorState.CLOSING);
                    that.targetState = DoorState.CLOSED;
                    that.targetDoorState.updateValue(DoorState.CLOSED);
                    if (!that.operating) {
                        setTimeout(that.setFinalDoorState.bind(that), that.doorOpensInSeconds * 1000);
                        that.operating = true;
                    }
                }
            }
        });
    },

    getTargetState: function(callback) {
        callback(null, this.targetState);
    },
    
    getObstructionState: function(callback) {
        callback(null, Characteristic.ObstructionDetected.FALSE);
    },

    readPin: function(pin) {
        return pin.readSync();
    },

    writePin: function(pin,val) {
        pin.writeSync(val);
    },

    isClosed: function() {
        return this.readPin(this.closedDoorSensor) == this.closedDoorSensorValue;
    },

    isOpen: function() {
        return this.readPin(this.openDoorSensor) == this.openDoorSensorValue;
    },

    switchOn: function() {
        this.writePin(this.doorButton, this.relayOn);
        this.log("Turning on GarageDoor Relay, pin " + this.doorSwitchPin + " = " + this.relayOn);
        // we have to do it this way instead of using a lambda inside the setTimeout in order
        // to bind the context of 'this' inside the callback to call this.writePin() to turn the relay off
        setTimeout(this.switchOff.bind(this), this.doorSwitchPressTimeInMs);
    },
    
    switchOff: function() {
        this.writePin(this.doorButton, this.relayOff);
        this.log("Turning off GarageDoor Relay, pin " + this.doorSwitchPin + " = " + this.relayOff);
    },

    setFinalDoorState: function() {
        this.log("setting final door state");
        this.operating = false;
        if (this.isClosed()) {
            this.currentDoorState.updateValue(DoorState.CLOSED);
        } else if (this.isOpen()) {
            this.currentDoorState.updateValue(DoorState.OPEN);
        } else {
            this.currentDoorState.updateValue(DoorState.STOPPED);
        }
        this.isSoftwareSwitch = false;
        this.log("   " + this.currentDoorState.value);
    },
    
    checkOpeningClosing: function() {
        this.log("checkOpeningClosing...");
        let moving = false;
        if (this.targetState == DoorState.CLOSED && this.openDoorSensor.readSync() == 0) {
            moving = true;
            this.log("  moving is true, currentState set to CLOSING");
            this.currentDoorState.updateValue(DoorState.CLOSING);
        }
        if (this.targetState == DoorState.OPEN && this.closedDoorSensor.readSync() == 0) {
            moving = true;
            this.log("  moving is true, currentState set to OPENING");
            this.currentDoorState.updateValue(DoorState.OPENING);
        }
        if (moving) {
            this.operating = true;
            setTimeout(this.setFinalDoorState.bind(this), this.doorOpensInSeconds * 1000);
        }
    },
    
    setState: function(state, callback) {
        this.log("Setting target state to " + doorStateToString(state));
        this.targetState = state
        this.targetDoorState.updateValue(state);
        if ((state == DoorState.OPEN && this.isClosed()) || (state == DoorState.CLOSED && this.isOpen())) {
            this.log("Triggering GarageDoor Relay");
            setTimeout(this.checkOpeningClosing.bind(this), 800);
            this.switchOn();
            this.isSoftwareSwitch = true;
        }
        callback(null);
    },

    getState: function(callback) {
        this.log("call to getState...");
        var isClosed = this.isClosed();
        var isOpen = this.isOpen();
        let state;
        if (this.operating) {
            state = this.targetState == DoorState.OPEN ? DoorState.OPENING : DoorState.CLOSING;
        } else {
            state = isClosed ? DoorState.CLOSED : isOpen ? DoorState.OPEN : DoorState.STOPPED;
        }
        this.log("  GarageDoor is " + (isClosed ? "CLOSED ("+DoorState.CLOSED+")" : isOpen ? "OPEN ("+DoorState.OPEN+")" : "STOPPED (" + DoorState.STOPPED + ")")); 
        callback(null, state);
    },

    getServices: function() {
        return [this.infoService, this.garageDoorOpener];
    }
};
