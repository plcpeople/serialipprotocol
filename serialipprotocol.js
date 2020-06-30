// NodeSerialIP - A library for communication to Siemens PLCs from node.js.

// The MIT License (MIT)

// Copyright (c) 2020 Dana Moffit

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// EXTRA WARNING - This is BETA software and as such, be careful, especially when
// writing values to programmable controllers.
//
// Some actions or errors involving programmable controllers can cause injury or death,
// and YOU are indicating that you understand the risks, including the
// possibility that the wrong address will be overwritten with the wrong value,
// when using this library.  Test thoroughly in a laboratory environment.


var net = require("net");
var util = require("util");
var effectiveDebugLevel = 0; // intentionally global, shared between connections
var silentMode = false;

module.exports = NodeSerialIP;

function NodeSerialIP(opts) {
	opts = opts || {};
	silentMode = opts.silent || false;
	effectiveDebugLevel = opts.debug ? 99 : 0

	var self = this;

	self.resetPending = false;
	self.resetTimeout = undefined;
	self.isoclient = undefined;
	self.isoConnectionState = 0;
	self.requestMaxPDU = 960;
	self.requestMaxParallel = 8;
	self.maxParallel = 8;
	self.parallelJobsNow = 0;
	self.maxGap = 5;
	self.doNotOptimize = false;
	self.connectCallback = undefined;
	self.readDoneCallback = undefined;
	self.writeDoneCallback = undefined;
	self.connectTimeout = undefined;
	self.PDUTimeout = undefined;
	self.globalTimeout = 2500; // In many use cases we will want to increase this

	self.rack = 0;
	self.slot = 2;
	self.localTSAP = null;
	self.remoteTSAP = null;

	self.readPacketArray = [];
	self.writePacketArray = [];
	self.polledReadBlockList = [];
	self.instantWriteBlockList = [];
	self.globalReadBlockList = [];
	self.globalWriteBlockList = [];
	self.masterSequenceNumber = 1;
	self.translationCB = doNothing;
	self.connectionParams = undefined;
	self.connectionID = 'UNDEF';
	self.addRemoveArray = [];
	self.readPacketValid = false;
	self.writeInQueue = false;
	self.connectCBIssued = false;
	self.dropConnectionCallback = null;
	self.dropConnectionTimer = null;
	self.reconnectTimer = undefined;
	self.rereadTimer = undefined;
}

NodeSerialIP.prototype.setTranslationCB = function(cb) {
	var self = this;
	if (typeof cb === "function") {
		outputLog('Translation OK');
		self.translationCB = cb;
	}
}

NodeSerialIP.prototype.initiateConnection = function(cParam, callback) {
	var self = this;
	if (cParam === undefined) { cParam = { port: 4000, host: '127.0.0.1' }; }
	outputLog('Initiate Called - Connecting to Serial IP server with address and parameters:');
	outputLog(cParam);

	if (typeof (cParam.connection_name) === 'undefined') {
		self.connectionID = cParam.host + " P" + cParam.port;
	} else {
		self.connectionID = cParam.connection_name;
	}
	self.connectionParams = cParam;
	self.connectCallback = callback;
	self.connectCBIssued = false;
	self.connectNow(self.connectionParams, false);
}

NodeSerialIP.prototype.dropConnection = function(callback) {
	var self = this;

	// prevents triggering reconnection even after calling dropConnection (fixes #70)
	clearTimeout(self.reconnectTimer);
	clearTimeout(self.rereadTimer);
	clearTimeout(self.connectTimeout);
	clearTimeout(self.PDUTimeout);
	self.reconnectTimer = undefined;
	self.rereadTimer = undefined;
	self.connectTimeout = undefined;
	self.PDUTimeout = undefined;

	if (typeof (self.isoclient) !== 'undefined') {
		// store the callback and request and end to the connection
		self.dropConnectionCallback = callback;
		self.isoclient.end();
		// now wait for 'on close' event to trigger connection cleanup

		// but also start a timer to destroy the connection in case we do not receive the close
		self.dropConnectionTimer = setTimeout(function() {
			if (self.dropConnectionCallback) {
				// clean up the connection now the socket has closed
				self.connectionCleanup();
				// initate the callback
				self.dropConnectionCallback();
				// prevent any possiblity of the callback being called twice
				self.dropConnectionCallback = null;
			}
		}, 2500);
	} else {
		// if client not active, then callback immediately
		callback();
	}
}

NodeSerialIP.prototype.connectNow = function(cParam) {
	var self = this;

	// prevents any reconnect timer to fire this again
	clearTimeout(self.reconnectTimer);
	self.reconnectTimer = undefined;

	// Don't re-trigger.
	if (self.isoConnectionState >= 1) { return; }
	self.connectionCleanup();

        self.isoclient = net.connect(cParam);                                                                                                                                        

        self.isoclient.setTimeout(cParam.timeout || 5000, () => {                                                                                                                    
            self.isoclient.destroy();                                                                                                                                            
            self.connectError.apply(self, arguments);                                                                                                                            
        });                                                                                                                                                                          

        self.isoclient.once('connect', () => {                                                                                                                                       
            self.isoclient.setTimeout(0);                                                                                                                                                
            self.onTCPConnect.apply(self, arguments);                                                                                                                            
        });                                                                                                                                                                          

        self.isoConnectionState = 1;  // 1 = trying to connect  

	self.isoclient.on('error', function() {
            self.connectError.apply(self, arguments);
	});

	outputLog('<initiating a new connection ' + Date() + '>', 1, self.connectionID);
	outputLog('Attempting to connect to host...', 0, self.connectionID);
}

NodeSerialIP.prototype.connectError = function(e) {
	var self = this;

	// Note that a TCP connection timeout error will appear here.
	outputLog('We Caught a connect error ' + e.code, 0, self.connectionID);
	if ((!self.connectCBIssued) && (typeof (self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback(e);
	}
	self.isoConnectionState = 0;
}

NodeSerialIP.prototype.readWriteError = function(e) {
	var self = this;
	outputLog('We Caught a read/write error ' + e.code + ' - will DISCONNECT and attempt to reconnect.');
	self.isoConnectionState = 0;
	self.connectionReset();
}

NodeSerialIP.prototype.packetTimeout = function(packetType, packetSeqNum) {
	var self = this;
	outputLog('PacketTimeout called with type ' + packetType + ' and seq ' + packetSeqNum, 1, self.connectionID);
	if (packetType === "connect") {
		outputLog("TIMED OUT connecting to the server - Disconnecting", 0, self.connectionID);
		outputLog("Wait for 2 seconds then try again.", 0, self.connectionID);
		self.connectionReset();
		outputLog("Scheduling a reconnect from packetTimeout, connect type", 0, self.connectionID);
		clearTimeout(self.reconnectTimer);
		self.reconnectTimer = setTimeout(function() {
			outputLog("The scheduled reconnect from packetTimeout, connect type, is happening now", 0, self.connectionID);
			if (self.isoConnectionState === 0) {
				self.connectNow.apply(self, arguments);
			}
		}, 2000, self.connectionParams);
		return undefined;
	}
	if (packetType === "read") {
		outputLog("READ TIMEOUT on sequence number " + packetSeqNum, 0, self.connectionID);
		if (self.isoConnectionState === 4) { // Reset before calling writeResponse so ResetNow will take place this cycle 
			outputLog("ConnectionReset from read packet timeout.", 0, self.connectionID);
			self.connectionReset();
		}
		self.readResponse(undefined);
		return undefined;
	}
	outputLog("Unknown timeout error.  Nothing was done - this shouldn't happen.");
}

NodeSerialIP.prototype.writeItems = function(arg, value, cb) {
	var self = this;
	outputLog("Write called on SerialIP driver - write not supported", 0, self.connectionID);
	if (typeof(cb) === 'function') {
		process.nextTick(function() {
			cb(true);
		});
	}
}

NodeSerialIP.prototype.onTCPConnect = function() {
	var self = this, connBuf;

	outputLog('TCP Connection Established to ' + self.isoclient.remoteAddress + ' on port ' + self.isoclient.remotePort, 0, self.connectionID);

	// Track the connection state
	self.isoConnectionState = 4;  // 4 = TCP connected



	// Listen for a reply.
	self.isoclient.on('data', function() {
		self.onResponse.apply(self, arguments);
	});

	// Hook up the event that fires on disconnect
	self.isoclient.on('end', function() {
		self.onClientDisconnect.apply(self, arguments);
	});

    	// listen for close (caused by us sending an end)
	self.isoclient.on('close', function() {
		self.onClientClose.apply(self, arguments);

	});

	// We need to make sure we don't add this event every time if we call it on data.
	self.isoclient.on('error', function() {
		self.readWriteError.apply(self, arguments);
	});  // Might want to remove the self.connecterror listener

	if ((!self.connectCBIssued) && (typeof (self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback();
	}
}

NodeSerialIP.prototype.findItem = function(useraddr) {
	var self = this, i;
	var commstate = { value: self.isoConnectionState !== 4, quality: 'OK' };
	if (useraddr === '_COMMERR') { return commstate; }
	for (i = 0; i < self.polledReadBlockList.length; i++) {
		if (self.polledReadBlockList[i].useraddr === useraddr) { return self.polledReadBlockList[i]; }
	}
	return undefined;
}

NodeSerialIP.prototype.addItems = function(arg) {
	var self = this;
	self.addRemoveArray.push({ arg: arg, action: 'add' });
}

NodeSerialIP.prototype.addItemsNow = function(arg) {
	var self = this, i;
	outputLog("Adding " + arg, 0, self.connectionID);
	if (typeof (arg) === "string" && arg !== "_COMMERR") {
		self.polledReadBlockList.push(stringToSerialIPAddr(self.translationCB(arg), arg));
	} else if (Array.isArray(arg)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof (arg[i]) === "string" && arg[i] !== "_COMMERR") {
				self.polledReadBlockList.push(stringToSerialIPAddr(self.translationCB(arg[i]), arg[i]));
			}
		}
	}

	// Validity check.
	for (i = self.polledReadBlockList.length - 1; i >= 0; i--) {
		if (self.polledReadBlockList[i] === undefined) {
			self.polledReadBlockList.splice(i, 1);
			outputLog("Dropping an undefined request item.", 0, self.connectionID);
		}
	}
	//	self.prepareReadPacket();
	self.readPacketValid = false;
}

NodeSerialIP.prototype.removeItems = function(arg) {
	var self = this;
	self.addRemoveArray.push({ arg: arg, action: 'remove' });
}

NodeSerialIP.prototype.removeItemsNow = function(arg) {
	var self = this, i;
	if (typeof arg === "undefined") {
		self.polledReadBlockList = [];
	} else if (typeof arg === "string") {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			outputLog('TCBA ' + self.translationCB(arg));
			if (self.polledReadBlockList[i].addr === self.translationCB(arg)) {
				outputLog('Splicing');
				self.polledReadBlockList.splice(i, 1);
			}
		}
	} else if (Array.isArray(arg)) {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			for (var j = 0; j < arg.length; j++) {
				if (self.polledReadBlockList[i].addr === self.translationCB(arg[j])) {
					self.polledReadBlockList.splice(i, 1);
				}
			}
		}
	}
	self.readPacketValid = false;
	//	self.prepareReadPacket();
}

NodeSerialIP.prototype.readAllItems = function(arg) {
	var self = this;

	outputLog("Reading All Items (readAllItems was called)", 1, self.connectionID);

	if (typeof arg === "function") {
		self.readDoneCallback = arg;
	} else {
		self.readDoneCallback = doNothing;
	}

	if (self.isoConnectionState !== 4) {
		outputLog("Unable to read when not connected. Return bad values.", 0, self.connectionID);
	} // For better behaviour when auto-reconnecting - don't return now

	// Now we check the array of adding and removing things.  Only now is it really safe to do this.
	self.addRemoveArray.forEach(function(element) {
		outputLog('Adding or Removing ' + util.format(element), 1, self.connectionID);
		if (element.action === 'remove') {
			self.removeItemsNow(element.arg);
		}
		if (element.action === 'add') {
			self.addItemsNow(element.arg);
		}
	});

	self.addRemoveArray = []; // Clear for next time.

	self.prepareReadItems();

	outputLog("Setting Timeout NOW", 2, self.connectionID);	

	self.timeout = setTimeout(function() {
		self.packetTimeout.apply(self, arguments);
	}, self.globalTimeout, "read");
}

NodeSerialIP.prototype.isWaiting = function() {
	var self = this;
	return (self.isReading() || self.isWriting());
}

NodeSerialIP.prototype.isReading = function() {
	var self = this, i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i = 0; i < self.readPacketArray.length; i++) {
		if (self.readPacketArray[i].sent === true) { return true }
	}
	return false;
}

NodeSerialIP.prototype.isWriting = function() {
	var self = this, i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i = 0; i < self.writePacketArray.length; i++) {
		if (self.writePacketArray[i].sent === true) { return true }
	}
	return false;
}

NodeSerialIP.prototype.clearReadPacketTimeouts = function() {
	var self = this, i;
	outputLog('Clearing read PacketTimeouts', 1, self.connectionID);
	// Before we initialize the self.readPacketArray, we need to loop through all of them and clear timeouts.
	for (i = 0; i < self.readPacketArray.length; i++) {
		clearTimeout(self.readPacketArray[i].timeout);
		self.readPacketArray[i].sent = false;
		self.readPacketArray[i].rcvd = false;
	}
}

NodeSerialIP.prototype.prepareReadItems = function() {
	var self = this, i;

	var itemList = self.polledReadBlockList;				// The items are the actual items requested by the user

	// Validity check.
	for (i = itemList.length - 1; i >= 0; i--) {
		if (itemList[i] === undefined) {
			itemList.splice(i, 1);
			outputLog("Dropping an undefined request item.", 0, self.connectionID);
		}
	}

	// Sort the items using the sort function, by type and offset.
	itemList.sort(itemListSorter);

	// Just exit if there are no items.
	if (itemList.length === 0) {
		return undefined;
	}

	self.globalReadBlockList = itemList;

	self.clearReadPacketTimeouts();

	self.readPacketValid = true;

	self.reqTime = process.hrtime();
}


NodeSerialIP.prototype.onResponse = function(theData) {
	var self = this;
	
	self.readResponse(theData);

}

function doneSending(element) {
	return ((element.sent && element.rcvd) ? true : false);
}

NodeSerialIP.prototype.readResponse = function(data) {
	var self = this, i;
	var anyBadQualities;
	var dataPointer = 21; // For non-routed packets we start at byte 21 of the packet.  If we do routing it will be more than this.
	var dataObject = {};
	var theData;
	
	if (typeof data === "undefined") {
		theData = [];
	} else {
		theData = data.toString().split(",");
	}

	outputLog("ReadResponse called", 1, self.connectionID);

	for (i = 0; i < self.globalReadBlockList.length; i++) {
		if (self.globalReadBlockList[i].offset > 0 && self.globalReadBlockList[i].offset <= theData.length) { // offset 0 illegal
			self.globalReadBlockList[i].value = parseFloat(theData[self.globalReadBlockList[i].offset-1]);
			self.globalReadBlockList[i].quality = 'OK';

		} else {
			self.globalReadBlockList[i].value = self.globalReadBlockList[i].badValue();
			self.globalReadBlockList[i].quality = 'BAD 255';
		}
	}

	// Make a note of the time it took the PLC to process the request.
	self.reqTime = process.hrtime(self.reqTime);
	outputLog('Time is ' + self.reqTime[0] + ' seconds and ' + Math.round(self.reqTime[1] * 10 / 1e6) / 10 + ' ms.', 1, self.connectionID);

	outputLog('Clearing timeout NOW', 2, self.connectionID);

	clearTimeout(self.timeout);

	// Mark our packets unread for next time.
	for (i = 0; i < self.readPacketArray.length; i++) {
		self.readPacketArray[i].sent = false;
		self.readPacketArray[i].rcvd = false;
	}

	anyBadQualities = false;

	// Loop through the global block list...
	for (i = 0; i < self.globalReadBlockList.length; i++) {
		var lengthOffset = 0;

		outputLog('Address ' + self.globalReadBlockList[i].addr + ' has value ' + self.globalReadBlockList[i].value + ' and quality ' + self.globalReadBlockList[i].quality, 1, self.connectionID);
		if (!isQualityOK(self.globalReadBlockList[i].quality)) {
			anyBadQualities = true;
			dataObject[self.globalReadBlockList[i].useraddr] = self.globalReadBlockList[i].quality;
		} else {
			dataObject[self.globalReadBlockList[i].useraddr] = self.globalReadBlockList[i].value;
		}
	}

	if (self.resetPending) {
		outputLog('Calling reset from readResponse as there is one pending',0,self.connectionID);
		self.resetNow();
	}
	if (self.isoConnectionState === 0) {
		self.connectNow(self.connectionParams, false);
	}

	// Inform our user that we are done and that the values are ready for pickup.
	outputLog("We are calling back our readDoneCallback.", 1, self.connectionID);
	if (typeof (self.readDoneCallback) === 'function') {
		self.readDoneCallback(anyBadQualities, dataObject);
	}
}


NodeSerialIP.prototype.onClientDisconnect = function() {
	var self = this;
	outputLog('SerialIP connection DISCONNECTED.', 0, self.connectionID);

	// We issue the callback here for Honcho
	// If this is the case we need to issue the Connect CB in order to keep trying.
	if ((!self.connectCBIssued) && (typeof (self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback("Error - OnClientDisconnect");
	}

	// So now, let's try a "connetionReset".  This way, we are guaranteed to return values (or bad) and reset at the proper time.

	self.connectionReset();
}

NodeSerialIP.prototype.onClientClose = function() {
	var self = this;
    // clean up the connection now the socket has closed
		// We used to call self.connectionCleanup() here, but it caused problems.
		// However - realize that this event is also called when the OTHER END of the connection sends a FIN packet.
		// Certain situations (download user program to mem card on S7-400, pop memory card out of S7-300, both with NetLink) cause this to happen.
		// So now, let's try a "connetionReset".  This way, we are guaranteed to return values (even if bad) and reset at the proper time.
		// Without this, client applications had to be prepared for a read/write not returning.
	self.connectionReset();

    // initiate the callback stored by dropConnection
    if (self.dropConnectionCallback) {
        self.dropConnectionCallback();
        // prevent any possiblity of the callback being called twice
        self.dropConnectionCallback = null;
        // and cancel the timeout
        clearTimeout(self.dropConnectionTimer);
    }
}

NodeSerialIP.prototype.connectionReset = function() {
	var self = this;
	self.isoConnectionState = 0;
	self.resetPending = true;
	outputLog('ConnectionReset has been called to set the reset as pending', 0, self.connectionID);
	if (!self.isReading() && !self.isWriting() && !self.writeInQueue && typeof(self.resetTimeout) === 'undefined') { // We can no longer logically ignore writes here
		self.resetTimeout = setTimeout(function() {
			outputLog('Timed reset has happened. Ideally this would never be called as reset should be completed when done r/w.',0,self.connectionID);
			self.resetNow.apply(self, arguments);
		}, 3500);  // Increased to 3500 to prevent problems with packet timeouts
	}
	// We wait until read() is called again to re-connect.
}

NodeSerialIP.prototype.resetNow = function() {
	var self = this;
	self.isoConnectionState = 0;
	self.isoclient.end();
	outputLog('ResetNOW is happening', 0, self.connectionID);
	self.resetPending = false;
	// In some cases, we can have a timeout scheduled for a reset, but we don't want to call it again in that case.
	// We only want to call a reset just as we are returning values.  Otherwise, we will get asked to read // more values and we will "break our promise" to always return something when asked.
	if (typeof (self.resetTimeout) !== 'undefined') {
		clearTimeout(self.resetTimeout);
		self.resetTimeout = undefined;
		outputLog('Clearing an earlier scheduled reset', 0, self.connectionID);
	}
}

NodeSerialIP.prototype.connectionCleanup = function() {
	var self = this;
	self.isoConnectionState = 0;
	outputLog('Connection cleanup is happening', 0, self.connectionID);
	if (typeof (self.isoclient) !== "undefined") {
		// destroy the socket connection
		self.isoclient.destroy();
		self.isoclient.removeAllListeners('data');
		self.isoclient.removeAllListeners('error');
		self.isoclient.removeAllListeners('connect');
		self.isoclient.removeAllListeners('end');
		self.isoclient.removeAllListeners('close');
		self.isoclient.on('error',function() {
			outputLog('TCP socket error following connection cleanup');
		});
	}
	clearTimeout(self.timeout);


}

function stringToSerialIPAddr(addr, useraddr) {
	"use strict";
	var theItem, splitString, splitString2;

	if (useraddr === '_COMMERR') { return undefined; } // Special-case for communication error status - this variable returns true when there is a communications error

	theItem = new SerialIPItem();
	theItem.offset = parseInt(addr.slice(1));

	theItem.datatype = addr.charAt(0);

	theItem.addr = addr;
	if (useraddr === undefined) {
		theItem.useraddr = addr;
	} else {
		theItem.useraddr = useraddr;
	}

	return theItem;
}
/**
 * Internal Functions
 */
function SerialIPItem() { // Object
	// Save the original address
	this.addr = undefined;
	this.useraddr = undefined;

	this.addrtype = undefined;
	this.datatype = undefined;
	this.dbNumber = undefined;
	this.bitOffset = undefined;
	this.offset = undefined;
	this.arrayLength = undefined;

	// These next properties can be calculated from the above properties, and may be converted to functions.
	this.dtypelen = undefined;
	this.byteLength = undefined;
	this.byteLengthWithFill = undefined;

	// Note that read transport codes and write transport codes will be the same except for bits which are read as bytes but written as bits
	this.readTransportCode = undefined;
	this.writeTransportCode = undefined;

	// This is where the data can go that arrives in the packet, before calculating the value.
	this.byteBuffer = Buffer.alloc(8192);
	this.writeBuffer = Buffer.alloc(8192);

	// We use the "quality buffer" to keep track of whether or not the requests were successful.
	// Otherwise, it is too easy to lose track of arrays that may only be partially complete.
	this.qualityBuffer = Buffer.alloc(8192);
	this.writeQualityBuffer = Buffer.alloc(8192);

	// Then we have item properties
	this.value = undefined;
	this.writeValue = undefined;
	this.valid = false;
	this.errCode = undefined;

	// Then we have result properties
	this.part = undefined;
	this.maxPart = undefined;

	// Block properties
	this.isOptimized = false;
	this.resultReference = undefined;
	this.itemReference = undefined;

	// And functions...
	this.clone = function() {
		var newObj = new SerialIPItem();
		for (var i in this) {
			if (i == 'clone') continue;
			newObj[i] = this[i];
		} return newObj;
	};

	this.badValue = function() {
		switch (this.datatype) {
			case "DT":
			case "DTZ":
			case "DTL":
			case "DTLZ":
				return new Date(NaN);
			case "REAL":
			case "LREAL":
			case "R":
				return 0.0;
			case "DWORD":
			case "DINT":
			case "INT":
			case "LINT":
			case "WORD":
			case "B":
			case "BYTE":
			case "TIMER":
			case "COUNTER":
			case "I":
				return 0;
			case "X":
				return false;
			case "C":
			case "CHAR":
			case "S":
			case "STRING":
				// Convert to string.
				return "";
			default:
				outputLog("Unknown data type when figuring out bad value - should never happen.  Should have been caught earlier.  " + this.datatype);
				return 0;
		}
	};
}

function itemListSorter(a, b) {
	// Feel free to manipulate these next two lines...
	if (a.offset < b.offset) { return -1; }
	if (a.offset > b.offset) { return 1; }
	return 0;
}

function doNothing(arg) {
	return arg;
}

function isQualityOK(obj) {
	if (typeof obj === "string") {
		if (obj !== 'OK') { return false; }
	} else if (Array.isArray(obj)) {
		for (var i = 0; i < obj.length; i++) {
			if (typeof obj[i] !== "string" || obj[i] !== 'OK') { return false; }
		}
	}
	return true;
}

function outputLog(txt, debugLevel, id) {
	if (silentMode) return;

	var idtext;
	if (typeof (id) === 'undefined') {
		idtext = '';
	} else {
		idtext = ' ' + id;
	}
	if (typeof (debugLevel) === 'undefined' || effectiveDebugLevel >= debugLevel) { console.log('[' + process.hrtime() + idtext + '] ' + util.format(txt)); }
}
