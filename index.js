'use strict';

var mongoose = require('mongoose');
var irc = require('irc');
var _ = require('underscore');
var fs = require('fs');
var socketio = require('socket.io');
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
var io = socketio(httpServer);

// TODO: regex searches from db
io.on('connection', function(socket) {
    socket.on('backlog', function(query) {
        Messages.find({ channel: query.channel })
        .where('server').equals(query.server)
        .sort('date')
        .limit(query.limit)
        .exec(function(err, messages) {
            if(err) socket.emit('error', err);
            else socket.emit('backlog', messages);
        });
    });
});

mongoose.connect(config.mongodb);
var db = mongoose.connection;
var Schema = mongoose.Schema;
var messageSchema = new Schema({
    nick: String,
    message: String,
    date: { type: Date, default: Date.now, index: true },
    channel: String,
    server: String
});
var channelEventSchema = new Schema({
    nick: String,
    event: String,
    date: { type: Date, default: Date.now, index: true },
    channel: String,
    server: String
});

var Messages = mongoose.model('Messages', messageSchema);
var ChannelEvents = mongoose.model('ChannelEvents', channelEventSchema);

_.each(config.servers, function(serverConfig, serverName) {
    if(!ircConnections[serverName]) {
        ircConnections[serverName] = new irc.Client(serverConfig.hostname,
                                                    serverConfig.userName,
                                                    serverConfig);

        var server = ircConnections[serverName];
        var log = function(message) {
            console.log(serverName + ': ' + message);
        };

        log('using serverconfig: ' + JSON.stringify(serverConfig, null, 4));

        server.on('registered', function(message) {
            log('registered: ' + JSON.stringify(message, null, 4));
            io.sockets.emit('registered', {
                "name": serverName,
                "message": message
            });

            // autojoin channels
            var svChans = _.filter(config.channels, function(channel) {
                return channel.server === serverName;
            });
            _.each(svChans, function(chan) {
                server.join(chan.channel + (chan.key ? ' ' + chan.key : ''));
            });
        });
        server.on('message', function(from, to, text, message) {
            var msg = {
                nick: from,
                message: text,
                channel: to,
                server: serverName
            };
            Messages.create(msg);
            io.sockets.emit('message', msg);
            log('message from ' + from + ' to ' + to + ': ' + text);
        });
        server.on('notice', function(from, to, text, message) {
            log('notice from ' + from + ' to ' + to + ': ' + text);
        });
        server.on('nick', function(oldnick, newnick, channels, message) {
            // TODO: check if it was you, then change config
            log(oldnick + ' changed name to ' + newnick);
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
            log('raw: ' + JSON.stringify(message, null, 4));
        });
        server.on('join', function(channel, nick, message) {
            log(nick + ' joined ' + channel + ': ' + JSON.stringify(message, null, 4));
            console.log('server ' + util.inspect(server));

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
