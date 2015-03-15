'use strict';

var mongoose = require('mongoose');
var irc = require('irc');
var _ = require('underscore');
var fs = require('fs');
var util = require('util');
var configPath = process.env.HOME + '/.nodebnc/config.json';
var config = require(configPath);
var winston = require('winston');
var log = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({
            level: config.logLevel,
            colorize: config.logColorize,
            handleExceptions: config.logExceptions,
            json: config.logJson
        })
    ]
});

var ircServers = {};
var chanBacklog = {};
var chanEventBacklog = {};

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

// TODO: check where we actually need this insanity, currently it's everywhere
var lc = function(string) {
    return _.isString(string) ? string.toLowerCase() : undefined;
};
var lcAll = function(strings) {
    return _.map(strings, function(string) {
        return string.toLowerCase();
    });
};

var getNickList = function(chanId) {
    var server = ircServers[lc(chGetSv(chanId))];
    if(!server) {
        emitWarn('server ' + chGetSv(chanId) + ' not found', 'getNickList');
        return;
    }

    var c = server.chans[lc(chGetCh(chanId))];
    if(!c) {
        emitWarn('channel ' + chanId + ' not found', 'getNickList');
        return;
    }

    return c.users;
};

var sendAllNickLists = function(socket) {
    var nickLists = {};

    _.each(config.channels, function(channel) {
        nickLists[lc(channel.id)] = getNickList(channel.id);
    });

    socket.emit('nickLists', nickLists);
};
var sendNickList = function(chanId, socket) {
    var nickList = {};

    nickList[lc(chanId)] = getNickList(chanId);
    socket.emit('nickLists', nickList);
};

var getConfigChans = function(config) {
    return _.map(config.channels, function(channel) {
        return channel;
    });
};

var chGetSv = function(chanId) { return chanId.split(':')[0]; };
var chGetCh = function(chanId) {
    var ws = chanId.indexOf(' ');
    ws = ws !== -1 ? ws : chanId.length;
    return chanId.substr(0, ws).split(':')[1];
};
var chGetChWithKey = function(chanId) { return chanId.split(':')[1]; };

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

var findChanById = function(id) {
    _.find(config.channels, function(channel) {
        return lc(channel.id) === lc(id);
    });
};
var getChanIdPos = function(id) {
    _.findIndex(config.channels, function(channel) {
        return lc(channel.id) === lc(id);
    });
};

var getBacklog = function(channel, limit) {
    var bl = chanBacklog[lc(channel)];
    if(!bl)
        return [];

    return bl.slice(limit ? bl.length - limit : 0, bl.length);
};

io.on('connection', function(socket) {
    // emit your nicknames TODO: re-emit this if a nick changes
    var nicks = {};
    _.each(ircServers, function(server, svName) {
        nicks[svName] = ircServers[svName].nick;
    });
    socket.emit('nicks', nicks);

    // emit joined channels
    socket.emit('channels', config.channels);

    // state for all channels
    socket.on('getState', function(query) {
        var results = [];

        _.each(config.channels, function(channel) {
            _.each(getBacklog(channel.id, query.backlogLimit), function(message) {
                results.push(message);
            });
        });

        socket.emit('messages', results);
        sendAllNickLists(socket);
    });

    // state for a certain channel
    socket.on('getChannelState', function(query) {
        socket.emit('messages', getBacklog(query.channel, query.backlogLimit));
        sendNickList(query.channel, socket);
    });

    socket.on('search', function(query) {
        query.channel = lc(query.channel);
        Messages.find(_.pick(query, 'channel', 'nick', 'text'))
        .sort('date')
        .limit(query.backlogLimit)
        .exec(function(err, messages) {
            if(err) emitErr(err, 'onSearch');
            else socket.emit('results', messages);
        });
    });

    socket.on('clientBroadcast', function(data) {
        socket.broadcast.emit('clientBroadcast', data);
    });

    socket.on('join', function(channel) {
        var server = ircServers[chGetSv(channel.id)];
        if(!server) {
            emitErr('server not found', 'onJoin');
            return;
        }

        // TODO: check also that channel doesn't exist with key?
        if(!findChanById(channel.id)) {
            config.channels.push({
                id: channel.id,
                name: channel.name || channel.id
            });
            io.sockets.emit('channels', config.channels);
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        server.join(chGetChWithKey(channel.id));
    });

    socket.on('part', function(channel) {
        var server = ircServers[chGetSv(channel.id)];
        if(!server) {
            emitErr('server not found', 'onPart');
            return;
        }

        if(findChanById(channel.id))
            config.channels.splice(getChanIdPos(channel.id), 1);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        server.part(chGetCh(channel.id));
    });

    socket.on('renameChannel', function(info) {
        var channel = _.find(config.channels, function(channel) {
            return lc(channel.id) === lc(info.id);
        });
        if(channel) {
            channel.name = info.name;
            io.sockets.emit('channels', config.channels);
        }
    });
    socket.on('moveChannel', function(info) {
        var pos = getChanIdPos(info.id);
        if(pos !== -1) {
            var channel = config.channels.splice(pos, 1);
            if(info.pos > pos)
                info.pos--;
            config.channels.splice(info.pos, 0, channel[0]);
            io.sockets.emit('channels', config.channels);
        }
    });

    socket.on('message', function(message) {
        var channel = message.channel;
        var server = ircServers[chGetSv(channel.id)];
        if(!server) {
            emitErr('server not found', 'onMessage');
            return;
        }

        message.nick = server.nick;
        message.date = new Date().toISOString();

        io.sockets.emit('messages', [message]);
        server.say(chGetCh(channel.id), message.text);
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
    argument: String,
    event: String,
    date: { type: Date, default: Date.now, index: true },
    channel: String
});

var globalEventSchema = new Schema({
    nick: String,
    event: String,
    argument: String,
    date: { type: Date, default: Date.now, index: true },
    svName: String
});

var Messages = mongoose.model('Messages', messageSchema);
var ChannelEvents = mongoose.model('ChannelEvents', channelEventSchema);
var GlobalEvents = mongoose.model('GlobalEvents', globalEventSchema);

var appendBacklog = function(backlogType, channel, message) {
    channel = lc(channel);
    if(!backlogType[channel])
        backlogType[channel] = [];

    var backlog = backlogType[channel];
    backlog.push(message);
    if(backlog.length > config.backlog)
        backlog.shift();
}

var handleMessage = function(from, to, text) {
    var msg = {
        nick: from,
        text: text,
        date: new Date().toISOString(),
        channel: to
    };
    Messages.create(msg);
    io.sockets.emit('messages', [msg]);
    appendBacklog(chanBacklog, to, msg);
    log.verbose('message from ' + from + ' to ' + to + ': ' + text);
};

var handleChannelEvent = function(event, nick, argument, channel) {
    var ev = {
        nick: nick,
        argument: argument,
        event: event,
        channel: channel
    };
    io.sockets.emit('channelEvent', ev);
    ChannelEvents.create(ev);
    appendBacklog(chanEventBacklog, channel, ev);
    log.verbose('event ' + event + ' from ' + nick + ' to ' + channel + ': ' + argument);
};

var handleGlobalEvent = function(event, nick, argument, svName) {
    var ev = {
        nick: nick,
        event: event,
        argument: argument,
        svName: svName
    };
    io.sockets.emit('globalEvent', ev);
    GlobalEvents.create(ev);
    log.verbose('globalEvent ' + event + ' from ' + nick + ' to ' + svName);
};

var handleNickChange = function(oldNick, newNick, channels, svName) {
    // TODO: check if it was you and act appropriately?
    handleGlobalEvent('nickChange', oldNick, JSON.stringify({
        newNick: newNick,
        channels: channels
    }), svName);

    log.verbose(oldNick + ' changed name to ' + newNick);
}

var handleRegister = function(message, server, svName) {
    log.info('registered: ' + svName);
    io.sockets.emit('registered', {
        svName: svName,
        nick: server.nick,
        message: message
    });

    // autojoin channels
    var svChans = _.filter(config.channels, function(channel) {
        return (chGetSv(channel.id) === svName);
    });
    _.each(svChans, function(channel) {
        ircServers[svName].join(chGetChWithKey(channel.id));
    });
}

var emitErr = function(err, where) {
    io.sockets.emit('bncErr', {
        error: err,
        where: where
    });
    log.error('in ' + where + ':', err);
};
var emitWarn = function(warn, where) {
    io.sockets.emit('bncWarn', {
        warn: warn,
        where: where
    });
    log.warn('in ' + where + ':', warn);
};

var handleChannelJoin = function(channel) {
    channel = lc(channel);
    Messages.find({ "channel": channel })
    .limit(config.backlogLimit)
    .sort({ date: 1 })
    .exec(function(err, results) {
        if(err) {
            emitErr(err, 'handleChannelJoin');
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
            handleRegister(message, server, svName);
        });
        server.on('message', function(from, to, text, message) {
            handleMessage(from, svName + ':' + to, text);
        });
        server.on('notice', function(from, to, text, message) {
            handleMessage(from, svName + ':' + to, text);
        });
        server.on('nick', function(oldnick, newnick, channels, message) {
            handleNickChange(oldnick, newnick, channels, svName);
        });
        server.on('invite', function(channel, from, message) {
            handleGlobalEvent('invite', from, channel, svName);
        });
        server.on('+mode', function(channel, by, mode, argument, message) {
            handleChannelEvent('+mode', by, JSON.stringify({
                target: argument,
                mode: mode
            }), svName + ':' + channel);
        });
        server.on('-mode', function(channel, by, mode, argument, message) {
            handleChannelEvent('-mode', by, JSON.stringify({
                target: argument,
                mode: mode
            }), svName + ':' + channel);
        });
        server.on('whois', function(info) {
            handleGlobalEvent('whois', null, info, svName);
        });
        server.on('raw', function(message) {
            log.silly('raw: ' + JSON.stringify(message));
        });
        server.on('join', function(channel, nick, message) {
            handleChannelEvent('join', nick, 'joined', svName + ':' + channel);

            if(nick === server.nick) {
                // we joined, get backlog for this channel
                log.verbose('joined ' + channel);
                handleChannelJoin(svName + ':' + channel);
            }
        });
        server.on('part', function(channel, nick, reason, message) {
            handleChannelEvent('part', nick, reason, svName + ':' + channel);
        });
        server.on('quit', function(nick, reason, channels, message) {
            handleGlobalEvent('quit', nick, JSON.stringify({
                channels: channels,
                reason: reason
            }), svName);
            log.verbose(nick + ' quit');
        });
        server.on('kick', function(channel, nick, by, reason, message) {
            handleChannelEvent('part', nick, 'kicked from channel: ' + reason, svName + ':' + channel);
        });
        server.on('kill', function(nick, reason, channels, message) {
            handleGlobalEvent('quit', nick, JSON.stringify({
                channels: channels,
                reason: 'killed from server: ' + reason
            }), svName);
        });
        server.on('names', function(channel, nicks) {
            log.debug('names in ' + channel + ': ' + JSON.stringify(nicks, null, 4));
            sendNickList(svName + ':' + channel, io.sockets);
        });
        server.on('topic', function(channel, topic, nick, message) {
            handleChannelEvent('topic', nick, topic, channel);
        });
        server.on('error', function(message) {
            log.error('server error ' + JSON.stringify(message, null, 4));
            handleGlobalEvent('error', message, 'an node-irc error occurred', svName);
        });
    }
});
