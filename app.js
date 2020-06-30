const express = require('express');
const request = require('request');
const bodyParser = require('body-parser');
const xml2js = require("xml2js");
const xpath = require("xml2js-xpath");
const _ = require('lodash');

/** ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- **/
var app = express();
app.use(bodyParser.text({limit: '10mb'}));
app.use(bodyParser.json({limit: '10mb'}));
app.use(bodyParser.urlencoded({limit: '100mb', extended: false}));

function flatten(obj) {
    var result = {};
    function recurse(src, prop) {
        var toString = Object.prototype.toString;
        if (toString.call(src) === '[object Object]') {
            var isEmpty = true;
            for (var p in src) {
                isEmpty = false;
                recurse(src[p], prop ? prop + '.' + p : p);
            }
            if (isEmpty && prop) {
                result[prop] = {};
            }
        } else if (toString.call(src) === '[object Array]') {
            var len = src.length;
            if (len > 0) {
                src.forEach(function (item, index) {
                    recurse(item, prop ? prop + '.[' + index + ']' : index);
                })
            } else {
                result[prop] = [];
            }
        } else {
            result[prop] = src;
        }
    }
    if (obj) {
        recurse(obj, '');
    }
    return result;
}

// 接收文本并解析三元组
app.post("/", function (req, response) {
    console.log('----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------');
    var text = '' + req.body;  // 原文文本
    console.log('text=' + text);  /////////////////////
    request.post({
        url: "http://ltp-svc:12345/ltp",  // "http://ltp.ruoben.com:8008/ltp"
        form: {
            s: text
        },
        timeout: 600000
    }, function (err, res, xmldoc) {
        if (err) {
            console.error(err);
            response.header('Content-Type', 'text/plain; charset=utf-8').status(500).end(err);
        } else {
            if (res.statusCode === 200) {
                xml2js.parseString(xmldoc, function (err, json) {
                    if (err) {
                        console.error(err);
                        response.header('Content-Type', 'text/plain; charset=utf-8').status(500).end(err);
                    } else {
                        response.header('Content-Type', 'application/json; charset=utf-8').status(200).end(JSON.stringify(parse(json)));
                    }
                });
            } else {
                console.error("调用ltp接口报错");
                response.header('Content-Type', 'text/plain; charset=utf-8').status(500).end("调用ltp接口报错");
            }
        }
    });
});

function parse(json) {
    var nested_triples = {}, flat_triples = {};
    var paras = json.xml4nlp.doc[0].para;
    for(var para_idx in paras) {
        var sents = paras[para_idx].sent;
        for(var sent_idx in sents) {
            var words = sents[sent_idx].word;
            for(var word_idx in words) {
                var word = words[word_idx];
                var key = fix(paras[para_idx].$.id, 2) + "-" + fix(sents[sent_idx].$.id, 2) + "-" + fix(word.$.id, 3);
                if ((word.$.pos === 'v' || word.arg && word.$.pos !== "p" && word.$.pos !== "nd" && word.$.pos !== "nt") && word.$.relate !== 'ADV' && JSON.stringify(nested_triples).indexOf(key) < 0) {
                    Object.assign(nested_triples, parse_triple(json, flat_triples, key, paras[para_idx].$.id, sents[sent_idx].$.id, word, null, words));
                }
            }
        }
    }
    var array = [];
    for(var id in nested_triples) {
        var instance = {};
        instance[id] = nested_triples[id];
        array.push(instance);
    }
    discard_id(array);
    console.log("三元组=" + JSON.stringify(array));  //////////////////
    return array;
}

function discard_id(array) {
    for(var index=0; index<array.length; index++) {
        for(var id in array[index]) {
            array[index] = array[index][id];
        }
        if (array[index].o && (typeof array[index].o) !== 'string') {
            discard_id(array[index].o);
        }
    }
}

function fix(num, length) {
    return ('' + num).length < length ? ((new Array(length + 1)).join('0') + num).slice(-length) : '' + num;
}
/*
word  谓语词
father_word 父谓语词
words   这个句子中的所有词
*/
function parse_triple(json, flat_triples, key, para_id, sent_id, word, father_word, words) {
    var triples = {};
    triples[key] = {};
    /*
    找主语 ********************************************************************************************************************************************************************************************
    */
    var subject_found = false;
    // 按主谓找，能找到的主语是最短的（有利于实体链接），但信息量小，所以加定语
    var child_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + word.$.id + "']");
    for(var child_word_idx in child_words) {
        var child_word = child_words[child_word_idx];
        if (child_word.$.relate === 'SBV') {  // 主语中心语
            subject_found = true;
            if (child_word.arg) {  // 主语又是三元组
                var triple = parse_triple(json, flat_triples, fix(para_id, 2) + "-" + fix(sent_id, 2) + "-" + fix(child_word.$.id, 3), para_id, sent_id, child_word, word, words);
                if ((typeof triple) !== 'string') {  //主语是三元组
                    var flat_triple = flatten(triple);  // 扁平化
                    triple = "";
                    for (var k in flat_triple) {
                        triple += flat_triple[k];
                    }
                }
                triples[key]["s"] = triple;
            } else {
                var att = parse_att(json, para_id, sent_id, child_word.$.id, words);  // 得到主语中心语的定语
                triples[key]["s"] = ((att === "")?"":"((" + att + "))") + child_word.$.cont;
            }
            break;
        }
    }
    // 按COO并列关系找主语
    if (!subject_found && word.$.relate === 'COO') {
        var coo_word = flat_triples[fix(para_id, 2) + "-" + fix(sent_id, 2) + "-" + fix(word.$.parent, 3)];
        if (coo_word && coo_word["s"]) {
            subject_found = true;
            triples[key]["s"] = coo_word["s"];
        }
    }
    // 按srl A0找主语
    if (!subject_found && word.arg) {
        for(var arg_idx in word.arg) {
            var arg = word.arg[arg_idx].$;
            if (arg.type === 'A0') {  // 动作的施加者，主语
                subject_found = true;
                var subject = '';
                for(var i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                    var w = words[i].$;
                    if (w.pos === 'ws') {
                        subject += w.cont + ' ';
                    } else if (w.pos === 'm' && i === parseInt(arg.end) && i < words.length - 1 && words[i+1].$.pos === 'q') {
                        subject += w.cont + words[i+1].$.cont;
                    } else {
                        subject += w.cont;
                    }
                }
                triples[key]["s"] = subject;
                break;
            }
        }
    }
    // 二级主语有可能是兼语
    if (!subject_found && father_word !== null) {  // 二级
        var dbl_child_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + father_word.$.id + "']");
        for(var dbl_child_word_idx in dbl_child_words) {
            var dbl_child_word = dbl_child_words[dbl_child_word_idx].$;
            if (dbl_child_word.relate === 'DBL') {  // 兼语，因为作二级的主语，信息量小，所以加定语
                subject_found = true;
                att = parse_att(json, para_id, sent_id, dbl_child_word.id, words);  // 得到兼语的定语
                triples[key]["s"] = ((att === "")?"":"((" + att + "))") + dbl_child_word.cont;
                break;
            }
        }
    }
    if (!subject_found && father_word === null) {  // 一级没主语视同于没有
        return {};
    }
    /*
    找谓语修饰语和补语（动补结构），合并到谓语中 *********************************************************************************************************************************************************
    */
    var advs = [], cmps = [];
    // 处理arg
    if (word.arg) {
        for(arg_idx in word.arg) {
            arg = word.arg[arg_idx].$;
            if (arg.type === 'ADV' || arg.type === 'LOC' || arg.type === 'TMP' || arg.type === 'MNR') {
                var array = [];
                for(i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                    w = words[i].$;
                    if (w.pos === 'ws') {
                        w.cont = w.cont + ' ';
                    } else if (w.pos === 'q' && words[i-1].$.pos === 'm') {
                        array.push(words[i-1].$);
                    }
                    array.push(w);
                }
                if (parseInt(arg.end) < parseInt(word.$.id)) {
                    advs = advs.concat(array);
                } else if (parseInt(arg.beg) > parseInt(word.$.id)) {
                    cmps = cmps.concat(array);
                }
            }
        }
    }
    // 处理修饰语和补语的父子关系
    for(child_word_idx in child_words) {
        child_word = child_words[child_word_idx].$;
        if (child_word.relate === 'ADV' || child_word.relate === 'ATT' || child_word.relate === 'LAD' && child_word.pos === 'u') {
            advs.push(child_word);
            var grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.id + "']");
            for(var grandchild_word_idx in grandchild_words) {
                var grandchild_word = grandchild_words[grandchild_word_idx].$;
                advs.push(grandchild_word);
                var great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + grandchild_word.id + "']");
                for(var great_grandchild_word_idx in great_grandchild_words) {
                    advs.push(great_grandchild_words[great_grandchild_word_idx].$);
                }
            }
        } else if (child_word.relate === 'CMP' || child_word.relate === 'RAD' && child_word.pos === 'u') {
            cmps.push(child_word);
            grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.id + "']");
            for(grandchild_word_idx in grandchild_words) {
                grandchild_word = grandchild_words[grandchild_word_idx].$;
                cmps.push(grandchild_word);
                great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + grandchild_word.id + "']");
                for(great_grandchild_word_idx in great_grandchild_words) {
                    cmps.push(great_grandchild_words[great_grandchild_word_idx].$);
                }
            }
        }
    }
    // 去掉标点
    _.remove(advs, function(word) {
        return word.pos === "wp";
    });
    _.remove(cmps, function(word) {
        return word.pos === "wp";
    });
    advs = _.sortBy(_.uniqBy(advs, 'id'), function(item) {
        return parseInt(item.id);
    });
    cmps = _.sortBy(_.uniqBy(cmps, 'id'), function(item) {
        return parseInt(item.id);
    });
    var adv = "", cmp = "";
    for(i = 0; i < advs.length; i++) {
        adv += advs[i].cont;
    }
    for(i = 0; i < cmps.length; i++) {
        cmp += cmps[i].cont;
    }
    if (cmp === '的') {  // 谓语的补语只有一个“的”字视同于没有
        return {};
    }
    triples[key]["p"] = ((adv === "")?"":"[[" + adv + "]]") + word.$.cont + ((cmp === "")?"":"{{" + cmp + "}}");
    /*
    找宾语 ********************************************************************************************************************************************************************************************
    */
    // 按srl A1找宾语
    var object_found = false;
    triples[key]["o"] = '';
    if (word.arg) {
        for(arg_idx in word.arg) {
            arg = word.arg[arg_idx].$;
            if (arg.type === 'A1') {  // 动作的受事者，宾语
                object_found = true;
                for(i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                    w = words[i].$;
                    if (w.pos === 'ws') {
                        triples[key]["o"] += w.cont + ' ';
                    } else if (w.pos === 'm' && i === parseInt(arg.end) && i < words.length - 1 && words[i+1].$.pos === 'q') {
                        triples[key]["o"] += w.cont + words[i+1].$.cont;
                    } else {
                        triples[key]["o"] += w.cont;
                    }
                }
                break;
            }
        }
    }
    // 按VOB找宾语
    for(child_word_idx in child_words) {
        child_word = child_words[child_word_idx];
        if (child_word.$.relate === 'VOB') {  // 有宾语
            object_found = true;
            if ((child_word.$.pos === "v" || child_word.arg && child_word.$.pos !== 'p' && child_word.$.pos !== 'nd' && child_word.$.pos !== 'nt') && child_word.$.relate !== "ADV") {  // 二级又是三元组
                var triple = parse_triple(json, flat_triples, fix(para_id, 2) + "-" + fix(sent_id, 2) + "-" + fix(child_word.$.id, 3), para_id, sent_id, child_word, word, words);
                if ((typeof triple) === 'string') {  //宾语是动名词
                    triples[key]["o"] = triple;
                } else {
                    triples[key]["o"] = [];
                    triples[key]["o"].push(triple);
                    grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.$.id + "']");
                    for(child_word_idx in grandchild_words) {
                        grandchild_word = grandchild_words[child_word_idx];
                        if (grandchild_word.$.pos === "v" && grandchild_word.$.relate === 'COO') {
                            triple = parse_triple(json, flat_triples, fix(para_id, 2) + "-" + fix(sent_id, 2) + "-" + fix(grandchild_word.$.id, 3), para_id, sent_id, grandchild_word, child_word, words);
                            triples[key]["o"].push(triple);
                        }
                    }
                }
            } else {
                att = parse_att(json, para_id, sent_id, child_word.$.id, words);
                var obj = ((att === "")?"":"((" + att + "))") + child_word.$.cont;  // 带定语的宾语
                if ((att + child_word.$.cont).length >= triples[key]["o"].length) {  // 宾语越长信息量越大
                    triples[key]["o"] = obj;
                }
            }
            break;
        }
    }
    if (!subject_found && !object_found) {
        return triples[key]["p"];
    }
    Object.assign(flat_triples, triples);
    return triples;
}

// 解析定语
function parse_att(json, para_id, sent_id, word_id, words) {
    var atts = [];
    var child_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + word_id + "']");
    for(var child_word_idx in child_words) {
        var child_word = child_words[child_word_idx].$;
        if (child_word.relate === 'ATT') {
            if (child_word.pos === 'q') {  // 量词
                atts.push(words[parseInt(child_word.id) - 1].$);  // 把数词加进来
            }
            var grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.id + "']");
            for(var grandchild_word_idx in grandchild_words) {
                var grandchild_word = grandchild_words[grandchild_word_idx].$;
                var great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + grandchild_word.id + "']");
                for(var great_grandchild_word_idx in great_grandchild_words) {
                    atts.push(great_grandchild_words[great_grandchild_word_idx].$);
                }
                atts.push(grandchild_word);
            }
            atts.push(child_word);
        }
    }
    atts = _.sortBy(_.uniqBy(atts, 'id'), function(item) {
        return parseInt(item.id);
    });
    var att = "";
    for(var i = 0; i < atts.length; i++) {
        if (atts[i].pos === 'ws') {
            att += atts[i].cont + " ";
        } else {
            att += atts[i].cont;
        }
    }
    return att;
}

app.listen(50000, '0.0.0.0');