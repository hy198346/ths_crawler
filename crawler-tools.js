const fs = require("fs");
const util = require("util");
const options = { flags : 'a', encoding : 'utf8' };

exports.getTimeFormat = function(format) {
    return new Date().format(format);
}

exports.getTimeFormatWithDate = function(date, format) {
    return new Date(date).format(format);
}

exports.logFileInit = function() {
    let log_path = "./log-" + exports.getTimeFormat('yyyy-MM-dd') + ".log";
    let stdout = fs.createWriteStream(log_path, options);

    console.log = function() {
        stdout.write('[' + exports.getTimeFormat() + '] - ' + util.format.apply(null, arguments) + '\n');
        process.stdout.write(util.format.apply(null, arguments) + '\n');
    };
} 

// tool - string trim
exports.str_trim = function(str) {
    if (str == null) return str;
    return str.replace(/^\s*|\s*$/g,"");
};
// tool - timestamp
exports.timestamp = function () {
    return new Date().getTime();
}

Date.prototype.format = function(format) {
    if (!format) { format = 'yyyy-MM-dd HH:mm:ss.fff'; }
    let padNum = function(value, digits) {
        return Array(digits - value.toString().length + 1).join('0') + value;
    };
    let cfg = {
        yyyy : this.getFullYear(),
        MM : padNum(this.getMonth() + 1, 2),
        dd : padNum(this.getDate(), 2),
        HH : padNum(this.getHours(), 2),
        mm : padNum(this.getMinutes(), 2),
        ss : padNum(this.getSeconds(), 2),
        fff : padNum(this.getMilliseconds(), 3)
    };
    return format.replace(/([a-z]|[A-Z])(\1)*/ig, function(m) {
        return cfg[m];
    })
}
