/* jshint node: true */
"use strict";
var Service;
var Characteristic;
var DoorState;
var Gpio = require('onoff');

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
    
        this.infoService = new Service.AccessoryInformation();
        this.infoService
            .setCharacteristic(Characteristic.Manufacturer, "Opensource Community")
            .setCharacteristic(Characteristic.Model, "RaspPi GPIO GarageDoor")
            .setCharacteristic(Characteristic.SerialNumber, "Version 1.0.0");
    
        var initialDoorState = DoorState.MISSING;
        if (this.isCLosed()) initialDoorState = DoorState.CLOSED;
        if (this.isOpen()) initialDoorState = DoorState.OPEN;
        this.log("Initial Door State: " + initialDoorState);
        this.currentDoorState.updateValue(initialDoorState);
        this.targetDoorState.updateValue(initialDoorState);
    
        this.doorButton = new Gpio(this.doorSwitchPin, this.relayOff ? 'high' : 'low');
        if (this.hasClosedSensor()) {
            this.closedDoorSensor = new Gpio(this.closedDoorSensorPin, 'in', 'both', {debounceTimeout: 10});
            // this replaces monitorDoorState
            this.closedDoorSensor.watch(function (err, value) { //Watch for hardware interrupts
                if (err) { //if an error
                    console.error('There was an error', err); //output error message to console
                    this.currentDoorState.updateValue(DoorState.STOPPED);
                }
                if (value == this.closedDoorSensorValue) {
                    console.log("door is closed");
                    this.currentDoorState.updateValue(DoorState.CLOSED);
                } else {
                    console.log("door is opening");
                    this.currentDoorState.updateValue(DoorState.OPENING);
                }
            });
        }
        
        this.openDoorSensor = new Gpio(this.openDoorSensorPin, 'in', 'both', {debounceTimeout: 10});
        // this replaces monitorDoorState
        this.openDoorSensor.watch(function (err, value) { //Watch for hardware interrupts
            if (err) { //if an error
                console.error('There was an error', err); //output error message to console
                this.currentDoorState.updateValue(DoorState.STOPPED);
            }
            if (value == this.openDoorSensorValue) {
                console.log("door is open");
                this.currentDoorState.updateValue(DoorState.OPEN);
            } else {
                console.log("door is closing");
                this.currentDoorState.updateValue(DoorState.CLOSING);
            }
        });
    },

    getTargetState: function(callback) {
        callback(null, this.targetState);
    },

    readPin: function(pinGpio) {
        return pinGpio.readSync();
    },

    writePin: function(pinGpio,val) {
        pin.writeSync(val);
    },

    isClosed: function() {
        return this.readPin(this.closedDoorSensorPin) == this.closedDoorSensorValue;
    },

    isOpen: function() {
        return this.readPin(this.openDoorSensorPin) == this.openDoorSensorValue;
    },

    switchOn: function() {
        this.writePin(this.doorSwitchPin, this.relayOn);
        this.log("Pushing the garage door button.");
        setTimeout(() => this.writePin(this.doorSwitchPin, this.relayOff), this.doorSwitchPressTimeInMs);
    },

    setFinalDoorState: function() {
        // basically, this just needs to check if we're still OPENING or CLOSING,
        //       and if so, signal a problem and set state to STOPPED i guess
        if ( (this.targetState == DoorState.CLOSED && !this.isClosed()) || (this.targetState == DoorState.OPEN && !this.isOpen()) ) {
            this.log("Was trying to " + (this.targetState == DoorState.CLOSED ? "CLOSE" : "OPEN") + " the door, but it is still " + (this.isClosed() ? "CLOSED":"OPEN"));
            this.currentDoorState.updateValue(DoorState.STOPPED);
        }
    },

    setState: function(state, callback) {
        this.log("Setting state to " + state);
        this.targetState = state;
        var isClosed = this.isClosed();
        if ((state == DoorState.OPEN && this.isClosed) || (state == DoorState.CLOSED && this.isOpen)) {
            this.log("Triggering GarageDoor Relay");
            setTimeout(this.setFinalDoorState.bind(this), this.doorOpensInSeconds * 1000);
            this.switchOn();
        }
        callback(null);
    },

    getState: function(callback) {
        var isClosed = this.isClosed();
        var isOpen = this.isOpen();
        // TODO: do i need to have this function try to determine OPENING/CLOSING state?
        //       or is OPEN/CLOSED/STOPPED good enough?
        var state = isClosed ? DoorState.CLOSED : isOpen ? DoorState.OPEN : DoorState.STOPPED;
        this.log("GarageDoor is " + (isClosed ? "CLOSED ("+DoorState.CLOSED+")" : isOpen ? "OPEN ("+DoorState.OPEN+")" : "STOPPED (" + DoorState.STOPPED + ")")); 
        callback(null, state);
    },

    getServices: function() {
        return [this.infoService, this.garageDoorOpener];
    }
};
