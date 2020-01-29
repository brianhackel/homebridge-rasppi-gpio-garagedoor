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
    
        var that = this;
        this.closedDoorSensor.watch(function (err, value) { //Watch for hardware interrupts
            if (err) { //if an error
                console.error('There was an error', err); //output error message to console
                that.currentDoorState.updateValue(DoorState.STOPPED);
            }
            if (value == that.closedDoorSensorValue) {
                console.log("door is closed");
                that.currentDoorState.updateValue(DoorState.CLOSED);
            } else {
                console.log("door is opening");
                that.currentDoorState.updateValue(DoorState.OPENING);
            }
        });
        
        this.openDoorSensor.watch(function (err, value) { //Watch for hardware interrupts
            if (err) { //if an error
                console.error('There was an error', err); //output error message to console
                that.currentDoorState.updateValue(DoorState.STOPPED);
            }
            if (value == that.openDoorSensorValue) {
                console.log("door is open");
                that.currentDoorState.updateValue(DoorState.OPEN);
            } else {
                console.log("door is closing");
                that.currentDoorState.updateValue(DoorState.CLOSING);
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
        // basically, this just needs to check if we're still OPENING or CLOSING,
        //       and if so, signal a problem and set state to STOPPED i guess
        this.operating = false;
        if ( (this.targetState == DoorState.CLOSED && !this.isClosed()) || (this.targetState == DoorState.OPEN && !this.isOpen()) ) {
            this.log("Was trying to " + (this.targetState == DoorState.CLOSED ? "CLOSE" : "OPEN") + " the door, but it is still " + (this.isClosed() ? "CLOSED":"OPEN"));
            this.currentDoorState.updateValue(DoorState.STOPPED);
        }
    },

    setState: function(state, callback) {
        this.log("Setting state to " + doorStateToString(state));
        this.targetState = state;
        var isClosed = this.isClosed();
        if ((state == DoorState.OPEN && this.isClosed) || (state == DoorState.CLOSED && this.isOpen)) {
            this.log("Triggering GarageDoor Relay");
            setTimeout(this.setFinalDoorState.bind(this), this.doorOpensInSeconds * 1000);
            this.switchOn();
            this.operating = true;
        }
        callback(null);
    },

    getState: function(callback) {
        var isClosed = this.isClosed();
        var isOpen = this.isOpen();
        // TODO: do i need to have this function try to determine OPENING/CLOSING state?
        //       or is OPEN/CLOSED/STOPPED good enough?
        // FIXME: look at the target state, compare to isopen and isclosed to determine
        let state;
        if (this.operating) {
            state = this.targetState == DoorState.OPEN ? DoorState.OPENING : DoorState.CLOSING;
        } else {
            state = isClosed ? DoorState.CLOSED : isOpen ? DoorState.OPEN : DoorState.STOPPED;
        }
        this.log("GarageDoor is " + (isClosed ? "CLOSED ("+DoorState.CLOSED+")" : isOpen ? "OPEN ("+DoorState.OPEN+")" : "STOPPED (" + DoorState.STOPPED + ")")); 
        callback(null, state);
    },

    getServices: function() {
        return [this.infoService, this.garageDoorOpener];
    }
};
