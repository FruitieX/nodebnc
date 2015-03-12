'use strict';

var mongoose = require('mongoose');
var irc = require('irc');
var _ = require('underscore');
var fs = require('fs');
var util = require('util');

var ircServers = {};
var chanBacklog = {};
var chanEventBacklog = {};
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
        emitError('server ' + chGetSv(channel) + ' not found', 'sendNickList');
        return;
    }

    var c = server.chans[chGetCh(channel)];
    if(!c) {
        emitError('channel ' + channel + ' not found', 'sendNickList');
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
        var backlog = [];

        _.each(chanBacklog, function(messages, channel) {
            if(config.channels.indexOf(channel) !== -1) {
                var cnt = 0;
                for(var i = messages.length - 1; i >= 0; i--) {
                    backlog.push(messages[i]);

                    cnt++;
                    if(query && query.limit && cnt >= query.limit)
                        break;
                }
            }
        });

        socket.emit('messages', backlog);
        sendAllNickLists(socket);
    });

    socket.on('search', function(query) {
        Messages.find(_.pick(query, 'channel', 'nick', 'text'))
        .sort('date')
        .limit(query.limit)
        .exec(function(err, messages) {
            if(err) emitError(err, 'onSearch');
            else socket.emit('results', messages);
        });
    });

    socket.on('clientBroadcast', function(data) {
        socket.broadcast.emit(data);
    });

    socket.on('join', function(channel) {
        var server = ircServers[chGetSv(channel)];
        if(!server) {
            emitError('server not found', 'onJoin');
            return;
        }

        // TODO: check also that channel doesn't exist with key?
        if(config.channels.indexOf(channel) === -1)
            config.channels.push(channel);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        server.join(chGetChWithKey(channel));
    });

    socket.on('part', function(channel) {
        var server = ircServers[chGetSv(channel)];
        if(!server) {
            emitError('server not found', 'onPart');
            return;
        }

        if(config.channels.indexOf(channel) !== -1)
            config.channels.splice(channel.channels.indexOf(channel), 1);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        server.part(chGetCh(channel));
    });

    socket.on('getChannels', function() {
        socket.emit('channels', config.channels);
    });

    socket.on('message', function(message) {
        var server = ircServers[chGetSv(message.channel)];
        if(!server) {
            emitError('server not found', 'onMessage');
            return;
        }

        message.nick = server.nick;
        message.date = new Date().toISOString();

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

var appendBacklog = function(backlogType, channel, message) {
    if(!backlogType[channel])
        backlogType[channel] = [];

    var backlog = backlogType[channel];
    backlog.push(message);
    if(backlog.length > config.backlog)
        backlog.shift();
}

var handleMessage = function(from, to, text, svName) {
    var channel = svName + ':' + to;
    var msg = {
        nick: from,
        text: text,
        date: new Date().toISOString(),
        channel: channel
    };
    Messages.create(msg);
    io.sockets.emit('message', msg);
    appendBacklog(chanBacklog, channel, msg);
    console.log('message from ' + from + ' to ' + to + ': ' + text);
};

var handleChannelEvent = function(event, nick, argument, channel, svName) {
    var channel = svName + ':' + channel;
    var ev = {
        nick: nick,
        argument: argument,
        event: event,
        channel: svName + ':' + channel
    };
    io.sockets.emit('channelEvent', ev);
    ChannelEvents.create(ev);
    appendBacklog(chanEventBacklog, channel, ev);
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

var emitError = function(err, where) {
    io.sockets.emit('bncErr', {
        error: err,
        where: where
    });
    console.log('ERROR in ' + where + ':');
    console.log(err);
};

var handleChannelJoin = function(channel) {
    Messages.find({ "channel": channel })
    .limit(config.backlog)
    .sort({ date: 1 })
    .exec(function(err, results) {
        if(err) {
            emitError(err, 'handleChannelJoin');
        } else {
            chanBacklog[channel] = results;
            io.sockets.emit('backlogAvailable', channel);
        }
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

            if(nick === server.nick) {
                // we joined, get backlog for this channel
                console.log('joined ' + channel);
                handleChannelJoin(svName + ':' + channel);
            }
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
