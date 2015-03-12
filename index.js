'use strict';

var mongoose = require('mongoose');
var irc = require('irc');
var _ = require('underscore');
var fs = require('fs');
var util = require('util');

var ircServers = {};
var configPath = process.env.HOME + '/.nodebnc/config.json';
var config = require(configPath);

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

var getNickList = function(channel) {
    var server = ircServers[chGetSv(channel)];
    if(!server) {
        socket.emit('bncErr', 'sendNickList: server not found');
        return;
    }

    var c = server.chans[chGetCh(channel)];
    if(!c) {
        socket.emit('bncErr', 'sendNickList: channel ' + channel + ' not found');
        return;
    }

    return c.users;
};

var sendAllNickLists = function(socket) {
    var nickLists = {};

    _.each(config.channels, function(channel) {
        nickLists[channel] = getNickList(channel);
    });

    socket.emit('nickLists', nickLists);
};
var sendNickList = function(channel, socket) {
    var nickList = getNickList(channel);
    socket.emit('nickList', nickList);
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
        Messages.aggregate( [
            { $match: { channel: {$in: getConfigChans(config) } } },
            { $sort:  { date: 1 } },
            { $group: { _id: "$channel", messages: { $push: "$$ROOT" } } },
            { $limit: query.limit }
        ])
        .exec(function(err, messages) {
            if(err) {
                socket.emit('bncErr', err);
            } else {
                socket.emit('messages', messages);
                sendAllNickLists(socket);
            }
        });
    });

    socket.on('search', function(query) {
        Messages.find(_.pick(query, 'channel', 'nick', 'text'))
        .sort('date')
        .limit(query.limit)
        .exec(function(err, messages) {
            if(err) socket.emit('bncErr', err);
            else socket.emit('results', messages);
        });
    });

    socket.on('clientBroadcast', function(data) {
        socket.broadcast.emit(data);
    });

    socket.on('join', function(channel) {
        var server = ircServers[chGetSv(channel)];
        if(!server) {
            socket.emit('bncErr', 'join: server not found');
            return;
        }

        // TODO: check also that channel doesn't exist with key?
        if(config.channels.indexOf(channel) === -1)
            config.channels.push(channel);

var config = require(process.env.HOME + '/.nodebnc/config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        server.join(chGetChWithKey(channel));
    });

    socket.on('part', function(channel) {
        var server = ircServers[chGetSv(channel)];
        if(!server) {
            socket.emit('bncErr', 'part: server not found');
            return;
        }

        if(config.channels.indexOf(channel) !== -1)
            config.channels.splice(channel.channels.indexOf(channel), 1);

        server.part(chGetCh(channel));
    });

    socket.on('getChannels', function() {
        socket.emit('channels', config.channels);
    });

    socket.on('message', function(message) {
        var server = ircServers[chGetSv(message.channel)];
        if(!server) {
            socket.emit('bncErr', 'part: server not found');
            return;
        }

        message.nick = server.nick;
        message.date = new Date().now;

        io.sockets.emit('message', message);
        server.say(chGetCh(message.channel), message.text);
    });

    socket.on('raw', function(data) {
        server.send(data);
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

var handleChannelEvent = function(event, nick, argument, channel, svName) {
    var ev = {
        nick: nick,
        argument: argument,
        event: event,
        channel: svName + ':' + channel
    };
    io.sockets.emit('channelEvent', ev);
    ChannelEvents.create(ev);
    console.log('event ' + event + ' from ' + nick + ' to ' + channel + ': ' + argument);
};

var handleGlobalEvent = function(event, nick, svName) {
    var ev = {
        nick: nick,
        event: event,
        svName: svName
    };
    io.sockets.emit('globalEvent', ev);
    GlobalEvents.create(ev);
    console.log('globalEvent ' + event + ' from ' + nick + ' to ' + svName);
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
    console.log(oldNick + ' changed name to ' + newNick);
}

var handleRegister = function(message, svName) {
    console.log('registered: ' + JSON.stringify(message, null, 4));
    io.sockets.emit('registered', {
        "name": svName,
        "message": message
    });

    // autojoin channels
    var svChans = _.filter(config.channels, function(channel) {
        return (chGetSv(channel) === svName);
    });
    _.each(svChans, function(channel) {
        ircServers[svName].join(chGetChWithKey(channel));
    });
}

_.each(config.servers, function(serverConfig, svName) {
    if(!ircServers[svName]) {
        ircServers[svName] = new irc.Client(serverConfig.hostname,
                                            serverConfig.userName,
                                            serverConfig);

        var server = ircServers[svName];

        server.on('registered', function(message) {
            handleRegister(message, svName);
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
            handleGlobalEvent('invite', from, svName);
        });
        server.on('+mode', function(channel, by, mode, argument, message) {
            handleChannelEvent('+mode', by, JSON.stringify({
                target: argument,
                mode: mode
            }), channel, svName);
        });
        server.on('-mode', function(channel, by, mode, argument, message) {
            handleChannelEvent('-mode', by, JSON.stringify({
                target: argument,
                mode: mode
            }), channel, svName);
        });
        server.on('whois', function(info) {
            handleGlobalEvent('whois', null, svName);
        });
        server.on('raw', function(message) {
            //console.log('raw: ' + JSON.stringify(message));
        });
        server.on('join', function(channel, nick, message) {
            handleChannelEvent('join', nick, null, channel, svName);
            //sendNickList(svName + ':' + channel, io.sockets);
        });
        server.on('part', function(channel, nick, reason, message) {
            handleChannelEvent('part', nick, reason, channel, svName);
            /*
            if(nick === server.nick) {
            } else {
                sendNickList(svName + ':' + channel, io.sockets);
            }
            */
        });
        server.on('quit', function(nick, reason, channels, message) {
            handleChannelEvent('quit', nick, reason, JSON.stringify(channels), svName);
            console.log(nick + ' quit');
        });
        server.on('kick', function(channel, nick, by, reason, message) {
            handleChannelEvent('part', nick, 'kicked from channel: ' + reason, channel, svName);
            //sendNickList(svName + ':' + channel, io.sockets);
        });
        server.on('kill', function(nick, reason, channels, message) {
            /*
            _.each(channels, function(channel) {
                sendNickList(svName + ':' + channel, io.sockets);
            });
            */
            handleChannelEvent('quit', nick, 'killed from server: ' + reason, JSON.stringify(channels), svName);
        });
        server.on('names', function(channel, nicks) {
            //console.log('names in ' + channel + ': ' + JSON.stringify(nicks, null, 4));
            sendNickList(svName + ':' + channel, io.sockets);
        });
        server.on('topic', function(channel, topic, nick, message) {
            handleChannelEvent('topic', nick, topic, channel, svName);
        });
        server.on('error', function(message) {
            console.log('server error ' + JSON.stringify(message, null, 4));
            handleGlobalEvent('error', message, svName);
        });
    }
});
