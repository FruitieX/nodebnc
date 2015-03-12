'use strict';

var mongoose = require('mongoose');
var irc = require('irc');
var _ = require('underscore');
var fs = require('fs');
var util = require('util');

var ircConnections = {};
var config = require(process.env.HOME + '/.nodebnc/config.json');

// networking
var options = {
    tls: config.tls,
    // TODO: make these configurable
    key: fs.readFileSync(process.env.HOME + '/.nodebnc/nodebnc-key.pem'),
    cert: fs.readFileSync(process.env.HOME + '/.nodebnc/nodebnc-cert.pem'),
    ca: fs.readFileSync(process.env.HOME + '/.nodebnc/nodebnc-cert.pem'),
    requestCert: config.requestCert,
    rejectUnauthorized: config.rejectUnauthorized
};

var httpServer = require(config.tls ? 'https': 'http')
.createServer(config.tls ? options: null).listen(config.port);
var io = require('socket.io')(httpServer);

var sendNickList = function(socket, channel) {
    var server = ircConnections[chGetSv(channel)];
    if(!server) {
        socket.emit('bncErr', 'sendNickList: server not found');
        return;
    }

    console.log(channel);
    console.log(chGetCh(channel));
    console.log(server.chans);
    var c = server.chans[chGetCh(channel)];
    if(!c) {
        socket.emit('bncErr', 'sendNickList: channel ' + channel + ' not found');
        return;
    }

    var nickList = c.users;
    socket.emit('nickList', {
        channel: channel,
        nickList: nickList
    });
};

var sendAllNickLists = function(socket) {
    _.each(config.channels, function(channel) {
        sendNickList(socket, channel);
    });
};

var getConfigChans = function(config) {
    return _.map(config.channels, function(channel) {
        return channel;
    });
};

var chGetSv = function(channel) { return channel.split(':')[0]; };
var chGetCh = function(channel) {
    var ws = channel.indexOf(' ');
    ws = ws !== -1 ? ws : channel.length;
    return channel.substr(0, ws).split(':')[1];
};
var chGetChWithKey = function(channel) { return channel.split(':')[1]; };

/*
var chIsShort = function(channel) { return channel.split(':').length > 1 };

var ch2short = function(channel) {
    _.find(config.channels, function(channel) {
        return channel.channel === channel ? channel.shortChName : false;
    });
};
var short2ch = function(shortChName) {
    _.find(config.channels, function(channel) {
        return channel.shortChName === shortChName ? channel.ircCh : false;
    });
};
*/

io.on('connection', function(socket) {
    socket.on('refreshState', function(query) {
        Messages.find({
            channel: { $in: getConfigChans(config) }
        })
        .sort('date')
        .limit(query.limit)
        .exec(function(err, messages) {
            if(err) {
                socket.emit('bncErr', err);
            } else {
                socket.emit('backlog', messages);
                sendAllNickLists(socket);
            }
        });
    });

    // TODO: regex searches from db
    socket.on('backlog', function(query) {
        Messages.find({ channel: query.channel })
        .sort('date')
        .limit(query.limit)
        .exec(function(err, messages) {
            if(err) socket.emit('bncErr', err);
            else socket.emit('backlog', messages);
        });
    });
});

mongoose.connect(config.mongodb);
var db = mongoose.connection;
var Schema = mongoose.Schema;
var messageSchema = new Schema({
    nick: String,
    text: String,
    date: { type: Date, default: Date.now, index: true },
    channel: String
});
var channelEventSchema = new Schema({
    nick: String,
    text: String,
    event: String,
    date: { type: Date, default: Date.now, index: true },
    channel: String
});

var globalEventSchema = new Schema({
    nick: String,
    event: String,
    date: { type: Date, default: Date.now, index: true },
    svName: String
});

var Messages = mongoose.model('Messages', messageSchema);
var ChannelEvents = mongoose.model('ChannelEvents', channelEventSchema);
var GlobalEvents = mongoose.model('GlobalEvents', globalEventSchema);

var handleMessage = function(from, to, text, svName) {
    var msg = {
        nick: from,
        text: text,
        channel: svName + ':' + to
    };
    Messages.create(msg);
    io.sockets.emit('message', msg);
    console.log('message from ' + from + ' to ' + to + ': ' + text);
};

var handleNickChange = function(oldNick, newNick, channels, svName) {
    _.each(channels, function(channel) {
        var event = {
            nick: oldNick,
            text: newNick,
            event: 'nickChange',
            channel: svName + ':' + channel
        };
    });

    // TODO: check if it was you and act appropriately
    log(oldNick + ' changed name to ' + newNick);
}

_.each(config.servers, function(serverConfig, svName) {
    if(!ircConnections[svName]) {
        ircConnections[svName] = new irc.Client(serverConfig.hostname,
                                                serverConfig.userName,
                                                serverConfig);

        var server = ircConnections[svName];
        var log = function(message) {
            console.log(svName + ': ' + message);
        };

        server.on('registered', function(message) {
            log('registered: ' + JSON.stringify(message, null, 4));
            io.sockets.emit('registered', {
                "name": svName,
                "message": message
            });

            // autojoin channels
            var svChans = _.filter(config.channels, function(channel) {
                return (chGetSv(channel) === svName);
            });
            _.each(svChans, function(channel) {
                server.join(chGetChWithKey(channel));
            });
        });
        server.on('message', function(from, to, text, message) {
            handleMessage(from, to, text, svName);
        });
        server.on('notice', function(from, to, text, message) {
            handleMessage(from, to, text, svName);
        });
        server.on('nick', function(oldnick, newnick, channels, message) {
            handleNickChange(oldnick, newnick, channels, svName);
        });
        server.on('invite', function(channel, from, message) {
            log('got invited to ' + channel + ' by ' + from);
        });
        server.on('+mode', function(channel, by, mode, argument, message) {
            log(channel + ': +' + mode + ' by ' + by + ': ' + argument);
        });
        server.on('-mode', function(channel, by, mode, argument, message) {
            log(channel + ': -' + mode + ' by ' + by + ': ' + argument);
        });
        server.on('whois', function(info) {
            log('whois info: ' + JSON.stringify(info, null, 4));
        });
        server.on('raw', function(message) {
            //log('raw: ' + JSON.stringify(message));
        });
        server.on('join', function(channel, nick, message) {
            log(nick + ' joined ' + channel + ': ' + JSON.stringify(message, null, 4));
            //console.log('server ' + util.inspect(server));

            // we joined
            if(nick === server.nick) {
                /*
                config.channels[channel] = {
                }
                */
            }
        });
        server.on('part', function(channel, nick, reason, message) {
            log(nick + ' left ' + channel + ': ' + JSON.stringify(message, null, 4));
        });
        server.on('quit', function(nick, reason, channels, message) {
            log(nick + ' quit');
        });
        server.on('kick', function(channel, nick, by, reason, message) {
            log(nick + ' kicked from ' + channel);
        });
        server.on('kill', function(nick, reason, channels, message) {
            log(nick + ' killed from server');
        });
        server.on('names', function(channel, nicks) {
            log('names in ' + channel + ': ' + JSON.stringify(nicks, null, 4));
        });
        server.on('topic', function(channel, topic, nick, message) {
            log('topic in ' + channel + ' changed to: ' + topic);
        });
        /*
        server.on('error', function(message) {
            log('server error ' + JSON.stringify(message, null, 4));
        });
        */
    }
});
