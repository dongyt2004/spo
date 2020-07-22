const express = require('express');
const request = require('request');
const bodyParser = require('body-parser');
const xml2js = require("xml2js");
const xpath = require("xml2js-xpath");
const _ = require('lodash');
const Levenshtein = require('levenshtein');

/** ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- **/
var app = express();
app.use(bodyParser.text({limit: '10mb'}));
app.use(bodyParser.json({limit: '10mb'}));
app.use(bodyParser.urlencoded({limit: '100mb', extended: false}));

// 接收文本并解析三元组
app.post("/", function (req, response) {
    console.log('----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------');
    var text = JSON.parse(JSON.stringify(req.body));  // 中文原始文本
    if ((typeof text) !== 'string') {
        text = Object.keys(text)[0];  // python调用时
    }
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
                if (!flat_triples.hasOwnProperty(key) && (word.$.pos === 'v' || word.arg && word.$.pos === 'i')) {
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
    array = dedup(array);
    console.log("三元组=" + JSON.stringify(array));  //////////////////
    return array;
}

function discard_id(array) {
    for(var index=0; index<array.length; index++) {
        if ((typeof  array[index]) !== 'string') {
            for(var id in array[index]) {
                array[index] = array[index][id];
            }
        }
        if (array[index].o) {
            discard_id(array[index].o);
        }
    }
}

function dedup(array) {
    var triple_array = [];
    for(var index=0; index<array.length; index++) {
        triple_array.push(stringify(array[index]));
    }
    var to_del_index = [];
    for(var i=0; i<triple_array.length; i++) {
        for(var j=i+1; j<triple_array.length; j++) {
            var ratio = 1 - new Levenshtein(triple_array[i], triple_array[j]).distance / Math.max(triple_array[i].length, triple_array[j].length);
            if (triple_array[i].indexOf(triple_array[j]) >= 0) {
                if (array[j].s.length === 0 || (typeof array[j].o) === 'string' && array[j].o.length === 0) {
                    to_del_index.push(j);
                }
            } else if (triple_array[j].indexOf(triple_array[i]) >= 0) {
                if (array[i].s.length === 0 || (typeof array[i].o) === 'string' && array[i].o.length === 0) {
                    to_del_index.push(i);
                }
            } else if (ratio > 0.6) {
                if (triple_array[i].length < triple_array[j].length) {
                    to_del_index.push(i);
                } else {
                    to_del_index.push(j);
                }
            }
        }
    }
    to_del_index = _.uniq(to_del_index);
    var all_index = [];
    for(index=0; index<array.length; index++) {
       all_index.push(index);
    }
    var retain_index = all_index.filter(function (val) { return to_del_index.indexOf(val) === -1 });
    var result = [];
    for(i = 0; i<retain_index.length; i++) {
        result.push(array[retain_index[i]]);
    }
    return result;
}

function stringify(spo_object) {
    var s = "";
    if ((typeof spo_object) === 'string') {
        s = spo_object;
    } else {
        s = spo_object.s + spo_object.p;
        if ((typeof spo_object.o) === "string") {
            s += spo_object.o;
        } else {
            for(var index=0; index<spo_object.o.length; index++) {
                s += stringify(spo_object.o[index]);
            }
        }
    }
    return s.replace(/{/g, "").replace(/}/g, "").replace(/\[/g, "").replace(/]/g, "").replace(/</g, "").replace(/>/g, "").replace(/【/g, "").replace(/】/g, "").replace(/《/g, "").replace(/》/g, "").replace(/`/g, "").replace(/\(/g, "").replace(/\)/g, "").replace(/~/g, "").replace(/«/g, "").replace(/»/g, "");
}

function fix(num, length) {
    return ('' + num).length < length ? ((new Array(length + 1)).join('0') + num).slice(-length) : '' + num;
}
/*
解析三元组，三元组就是事件
word  谓语词
father_word 父谓语词
words   这个句子中的所有词
*/
function parse_triple(json, flat_triples, key, para_id, sent_id, word, father_word, words) {
    var triples = {};
    triples[key] = {};
    /*
    找主语 ********************************************************************************************************************************************************************************************
    []：地点   <>：地点的方向  ()：修饰语   {}：数（量）词  《》：机构  ``：人名  【】：主语中心语   ~~：其他
    */
    var subject_found = false;
    triples[key]["s"] = '';
    // 按A0找主语
    var a0 = "";
    if (word.arg) {
        for(var arg_idx in word.arg) {
            var arg = word.arg[arg_idx].$;
            if (arg.type === 'A0' && parseInt(arg.end) < parseInt(word.$.id)) {  // 动作的施事者，主语
                subject_found = true;
                for(var i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                    var w = words[i].$;
                    if (w.pos === 'u') {
                        continue;
                    } else if (w.pos === 'ws') {
                        a0 += w.cont + ' ';
                    } else if (w.pos === 'm' && i === parseInt(arg.end) && i < words.length - 1 && words[i+1].$.pos === 'q') {
                        a0 += "{" + w.cont + words[i+1].$.cont + "}";
                    } else if (w.pos === 'm' || w.pos === 'q') {
                        a0 += "{" + w.cont + "}";
                    } else if (w.pos === 'nl' || w.pos === 'ns') {
                        a0 += "[" + w.cont + "]";
                    } else if (w.pos === 'nd') {
                        a0 += "<" + w.cont + ">";
                    } else if (w.pos === 'nh') {
                        a0 += "`" + w.cont + "`";
                    } else if (w.pos === 'ni') {
                        a0 += "《" + w.cont + "》";
                    } else if (w.pos === 'a' || w.pos === 'b') {
                        a0 += "(" + w.cont + ")";
                    } else {  // 其他
                        a0 += "~" + w.cont + "~";
                    }
                }
                break;
            }
        }
    }
    if (a0 !== '') {
        a0 = a0.replace(/\)\(/g, '').replace(/\]\[/g, '').replace(/></g, '').replace(/}{/g, '').replace(/~~/g, '').replace(/》《/g, '').replace(/``/g, '');
    }
    // 按主谓找，能找到的主语是最短的（有利于实体链接），但信息量小，所以加定语
    var sbv = "";
    var child_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + word.$.id + "']");
    for(var child_word_idx in child_words) {
        var child_word = child_words[child_word_idx];
        if (child_word.$.relate === 'SBV') {  // 主语中心语
            subject_found = true;
            if (child_word.$.pos === 'm' || child_word.$.pos === "q") {  // 主语中心语是数词或量词
                sbv = parse_att(json, para_id, sent_id, child_word.$.id, words) + "{" + child_word.$.cont + "}";
                sbv = sbv.replace(/}{/g, "");  // 带定语的主语
            } else {
                sbv = parse_att(json, para_id, sent_id, child_word.$.id, words) + "【" + child_word.$.cont + "】";  // 得到主语中心语的定语
            }
            break;
        }
    }
    var s1 = '';
    if (sbv !== '') {
        s1 = sbv.replace(/{/g, "").replace(/}/g, "").replace(/\[/g, "").replace(/]/g, "").replace(/</g, "").replace(/>/g, "").replace(/【/g, "").replace(/】/g, "").replace(/\(/g, "").replace(/\)/g, "").replace(/《/g, "").replace(/》/g, "").replace(/`/g, "").replace(/~/g, "");
    }
    var s2 = '';
    if (a0 !== '') {
        s2 = a0.replace(/{/g, "").replace(/}/g, "").replace(/\[/g, "").replace(/]/g, "").replace(/</g, "").replace(/>/g, "").replace(/【/g, "").replace(/】/g, "").replace(/\(/g, "").replace(/\)/g, "").replace(/《/g, "").replace(/》/g, "").replace(/`/g, "").replace(/~/g, "");
    }
    if (s1.length >= s2.length) {
        triples[key]["s"] = sbv;
    } else {
        triples[key]["s"] = a0;
    }
    // 按COO并列关系找主语
    if (!subject_found && word.$.relate === 'COO') {
        var coo_word = flat_triples[fix(para_id, 2) + "-" + fix(sent_id, 2) + "-" + fix(word.$.parent, 3)];
        if (coo_word && coo_word["s1"]) {
            subject_found = true;
            triples[key]["s"] = coo_word["s1"];
        }
    }
    // 二级主语有可能是上级的兼语
    if (!subject_found && father_word !== null) {  // 二级
        var dbl_child_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + father_word.$.id + "']");
        for(var dbl_child_word_idx in dbl_child_words) {
            var dbl_child_word = dbl_child_words[dbl_child_word_idx].$;
            if (dbl_child_word.relate === 'DBL') {  // 兼语，因为作二级的主语，信息量小，所以加定语
                subject_found = true;
                if (dbl_child_word.pos === 'm' || dbl_child_word.pos === "q") {  // 主语中心语是数词或量词
                    subject = parse_att(json, para_id, sent_id, dbl_child_word.id, words) + "{" + dbl_child_word.cont + "}";
                    triples[key]["s"] = subject.replace(/}{/g, "");  // 带定语的主语
                } else {
                    triples[key]["s"] = parse_att(json, para_id, sent_id, dbl_child_word.id, words) + "【" + dbl_child_word.cont + "】";  // 得到兼语的定语
                }
                break;
            }
        }
    }
    /*
    找谓语 *********************************************************************************************************************************************************
    ()：时间（状语或补语）   «»：时间的方向   []：地点（状语或补语）  <>：地点的方向   {}：数（量）词   【】：谓语中心语   ~~：其他
    */
    triples[key]["p"] = parse_predicate(json, para_id, sent_id, word, words);
    /*
    找宾语 ********************************************************************************************************************************************************************************************
    []：地点  <>：地点的方向  ()：修饰语  {}：数（量）词  《》：机构  ``：人名  【】：宾语中心语   ~~：其他
    */
    var object_found = false;
    triples[key]["o"] = '';
    // 按A1找宾语
    var a1 = "";
    if (word.arg) {
        for(arg_idx in word.arg) {
            arg = word.arg[arg_idx].$;
            if (arg.type === 'A1' && parseInt(arg.beg) > parseInt(word.$.id)) {  // 动作的受事者，宾语
                object_found = true;
                for(i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                    w = words[i].$;
                    if (w.pos === 'ws') {
                        a1 += w.cont + ' ';
                    } else if (w.pos === 'm' && i === parseInt(arg.end) && i < words.length - 1 && words[i+1].$.pos === 'q') {
                        a1 += "{" + w.cont + words[i+1].$.cont + "}";
                    } else if (w.pos === 'm' || w.pos === 'q') {
                        a1 += "{" + w.cont + "}";
                    } else if (w.pos === 'nl' || w.pos === 'ns') {
                        a1 += "[" + w.cont + "]";
                    } else if (w.pos === 'nd') {
                        a1 += "<" + w.cont + ">";
                    } else if (w.pos === 'nh') {
                        a1 += "`" + w.cont + "`";
                    } else if (w.pos === 'ni') {
                        a1 += "《" + w.cont + "》";
                    } else if (w.pos === 'a' || w.pos === 'b') {
                        a1 += "(" + w.cont + ")";
                    } else {  // 其他
                        a1 += "~" + w.cont + "~";
                    }
                }
                break;
            }
        }
    }
    if (a1 !== '') {
        var a2 = "";
        if (word.arg) {
            for(arg_idx in word.arg) {
                arg = word.arg[arg_idx].$;
                if (arg.type === 'A2' && parseInt(arg.beg) > parseInt(word.$.id)) {  // 动作的受事者，宾语
                    for(i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                        a2 += words[i].$.cont;
                    }
                    break;
                }
            }
        }
        if (a2 !== "") {
            a1 += "【" + a2 + "】";
        }
        a1 = a1.replace(/\)\(/g, '').replace(/\]\[/g, '').replace(/></g, '').replace(/}{/g, '').replace(/~~/g, '').replace(/》《/g, '').replace(/``/g, '');
    }
    // 按VOB找宾语
    var vob = "";
    for(child_word_idx in child_words) {
        child_word = child_words[child_word_idx];
        if (child_word.$.relate === 'VOB') {  // 宾语中心语
            object_found = true;
            if (child_word.$.pos === "v" || child_word.arg && child_word.$.pos !== 'p' && child_word.$.pos !== 'nd' && child_word.$.pos !== 'nt') {  // 二级又是三元组
                var triple = parse_triple(json, flat_triples, fix(para_id, 2) + "-" + fix(sent_id, 2) + "-" + fix(child_word.$.id, 3), para_id, sent_id, child_word, word, words);
                if (JSON.stringify(triple) !== "{}") {
                    vob = [];
                    vob.push(triple);
                    // 找宾语动词的并列词
                    var grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.$.id + "']");
                    for(var grandchild_word_idx in grandchild_words) {
                        var grandchild_word = grandchild_words[grandchild_word_idx];
                        if (grandchild_word.$.relate === 'COO' && grandchild_word.$.pos === "v") {
                            vob.push(parse_triple(json, flat_triples, fix(para_id, 2) + "-" + fix(sent_id, 2) + "-" + fix(grandchild_word.$.id, 3), para_id, sent_id, grandchild_word, child_word, words));
                        }
                    }
                }
            } else if (child_word.$.pos === "m" || child_word.$.pos === "q") {  // 宾语中心语是数词或量词
                vob = parse_att(json, para_id, sent_id, child_word.$.id, words) + "{" + child_word.$.cont + "}";
                vob = vob.replace(/}{/g, ""); // 带定语的宾语
            } else {
                vob = parse_att(json, para_id, sent_id, child_word.$.id, words) + "【" + child_word.$.cont + "】";  // 带定语的宾语
            }
            break;
        }
    }
    if ((typeof vob) === 'string') {
        s1 = '';
        if (vob !== '') {
            s1 = vob.replace(/{/g, "").replace(/}/g, "").replace(/\[/g, "").replace(/]/g, "").replace(/</g, "").replace(/>/g, "").replace(/【/g, "").replace(/】/g, "").replace(/\(/g, "").replace(/\)/g, "").replace(/《/g, "").replace(/》/g, "").replace(/`/g, "").replace(/~/g, "");
        }
        s2 = '';
        if (a1 !== '') {
            s2 = a1.replace(/{/g, "").replace(/}/g, "").replace(/\[/g, "").replace(/]/g, "").replace(/</g, "").replace(/>/g, "").replace(/【/g, "").replace(/】/g, "").replace(/\(/g, "").replace(/\)/g, "").replace(/《/g, "").replace(/》/g, "").replace(/`/g, "").replace(/~/g, "");
        }
        if (s1.length >= s2.length) {
            triples[key]["o"] = vob;
        } else {
            triples[key]["o"] = a1;
        }
    } else {
        triples[key]["o"] = vob;
    }
    if (!subject_found && !object_found) {
        if (father_word === null) {
            return {};
        } else {
            return triples[key]["p"];  //谓语是动名词
        }
    }
    Object.assign(flat_triples, triples);
    return triples;
}

// 解析定语
function parse_att(json, para_id, sent_id, word_id, words) {  // word_id是主语中心语或宾语中心语id
    var atts = [];
    var child_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + word_id + "']");
    for(var child_word_idx in child_words) {
        var child_word = child_words[child_word_idx].$;
        if (child_word.relate === 'ATT' || child_word.relate === 'SBV' || child_word.relate === 'COO' || child_word.relate === 'ADV' || child_word.relate === 'VOB' || child_word.relate === 'RAD' || child_word.relate === 'LAD') {
            var grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.id + "']");
            for(var grandchild_word_idx in grandchild_words) {
                var grandchild_word = grandchild_words[grandchild_word_idx].$;
                if (grandchild_word.relate === 'ATT' || grandchild_word.relate === 'SBV' || grandchild_word.relate === 'COO' || grandchild_word.relate === 'ADV' || grandchild_word.relate === 'VOB' || grandchild_word.relate === 'RAD' || grandchild_word.relate === 'LAD') {
                    var great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + grandchild_word.id + "']");
                    for(var great_grandchild_word_idx in great_grandchild_words) {
                        var great_grandchild_word = great_grandchild_words[great_grandchild_word_idx].$;
                        if (great_grandchild_word.relate === 'ATT' || great_grandchild_word.relate === 'SBV' || great_grandchild_word.relate === 'COO' || great_grandchild_word.relate === 'ADV' || great_grandchild_word.relate === 'VOB' || great_grandchild_word.relate === 'RAD' || great_grandchild_word.relate === 'LAD') {
                            var great_great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + great_grandchild_word.id + "']");
                            for(var great_great_grandchild_word_idx in great_great_grandchild_words) {
                                var great_great_grandchild_word = great_great_grandchild_words[great_great_grandchild_word_idx].$;
                                if (great_great_grandchild_word.relate === 'ATT' || great_great_grandchild_word.relate === 'SBV' || great_great_grandchild_word.relate === 'COO' || great_great_grandchild_word.relate === 'ADV' || great_great_grandchild_word.relate === 'VOB' || great_great_grandchild_word.relate === 'RAD' || great_great_grandchild_word.relate === 'LAD') {
                                    atts.push(great_great_grandchild_word);
                                }
                            }
                            atts.push(great_grandchild_word);
                        }
                    }
                    atts.push(grandchild_word);
                }
            }
            atts.push(child_word);
        }
    }
    // 去掉标点和在中心语后面的词
    _.remove(atts, function(word) {
        return word.pos === "wp" || parseInt(word.id) > parseInt(word_id);
    });
    atts = _.sortBy(_.uniqBy(atts, 'id'), function(item) {
        return parseInt(item.id);
    });
    var att = "";
    for(var i = 0; i < atts.length; i++) {
        if (atts[i].pos === 'nd') {
            att += "<" + atts[i].cont + ">";  // 地点的方位方向
        } else if (atts[i].pos === 'nh') {
            att += "`" + atts[i].cont + "`";
        } else if (atts[i].pos === 'ni') {
            att += "《" + atts[i].cont + "》";
        } else if (atts[i].pos === 'nl' || atts[i].pos === 'ns') {
            att += "[" + atts[i].cont + "]";
        } else if (atts[i].pos === 'm' || atts[i].pos === 'q') {
            att += "{" + atts[i].cont + "}";
        } else if (atts[i].pos === 'a' || atts[i].pos === 'b') {  // 纯形容词 或 名词性修饰语
            att += "(" + atts[i].cont + ")";
        } else if (atts[i].pos === 'ws') {
            att += atts[i].cont + ' ';
        } else {  // 其他
            att += "~" + atts[i].cont + "~";
        }
    }
    att = att.replace(/\)\(/g, '').replace(/\]\[/g, '').replace(/></g, '').replace(/}{/g, '').replace(/~~/g, '').replace(/》《/g, '').replace(/``/g, '');
    return att;
}

// 解析谓语
function parse_predicate(json, para_id, sent_id, word, words) {  // word是谓语中心语
    var advs = [], cmps = [];  // 状语 补语
    // 处理arg
    if (word.arg) {
        for(var arg_idx in word.arg) {
            var arg = word.arg[arg_idx].$;
            var array = [];
            if (arg.type === 'TMP') {  // 时间
                for(var i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                    if (words[i].$.cont.indexOf('(') < 0) {
                        words[i].$.cont = "(" + words[i].$.cont + ")";  // 修改了word本身，加()
                    }
                    array.push(words[i].$);
                }
            } else if (arg.type === 'LOC') {  // 地点
                for(i = parseInt(arg.beg); i <= parseInt(arg.end); i++) {
                    if (words[i].$.cont.indexOf('[') < 0) {
                        words[i].$.cont = "[" + words[i].$.cont + "]";  // 修改了word本身，加[]
                    }
                    array.push(words[i].$);
                }
            }
            if (parseInt(arg.end) < parseInt(word.$.id)) {
                advs = advs.concat(array);
            } else if (parseInt(arg.beg) > parseInt(word.$.id)) {
                cmps = cmps.concat(array);
            }
        }
    }
    // 处理状语的父子关系
    var child_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + word.$.id + "']");
    for(var child_word_idx in child_words) {
        var child_word = child_words[child_word_idx].$;
        if (child_word.relate === 'ADV' || child_word.relate === 'ATT') {  // 状语
            var grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.id + "']");
            for(var grandchild_word_idx in grandchild_words) {
                var grandchild_word = grandchild_words[grandchild_word_idx].$;
                if (grandchild_word.relate === 'ATT' || grandchild_word.relate === 'POB' || grandchild_word.relate === 'ADV' || grandchild_word.relate === 'VOB') {
                    var great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + grandchild_word.id + "']");
                    for(var great_grandchild_word_idx in great_grandchild_words) {
                        var great_grandchild_word = great_grandchild_words[great_grandchild_word_idx].$;
                        if (great_grandchild_word.relate === 'ATT' || great_grandchild_word.relate === 'POB' || great_grandchild_word.relate === 'ADV' || great_grandchild_word.relate === 'VOB') {
                            var great_great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + great_grandchild_word.id + "']");
                            for(var great_great_grandchild_word_idx in great_great_grandchild_words) {
                                var great_great_grandchild_word = great_great_grandchild_words[great_great_grandchild_word_idx].$;
                                if (great_great_grandchild_word.relate === 'ATT' || great_great_grandchild_word.relate === 'POB' || great_great_grandchild_word.relate === 'ADV' || great_great_grandchild_word.relate === 'VOB') {
                                    advs.push(great_great_grandchild_word);
                                }
                            }
                            advs.push(great_grandchild_word);
                        }
                    }
                    advs.push(grandchild_word);
                }
            }
            advs.push(child_word);
        } else if (child_word.relate === 'CMP') {  // 补语
            grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + child_word.id + "']");
            for(grandchild_word_idx in grandchild_words) {
                grandchild_word = grandchild_words[grandchild_word_idx].$;
                if (grandchild_word.relate === 'ATT' || grandchild_word.relate === 'POB' || grandchild_word.relate === 'ADV' || grandchild_word.relate === 'VOB') {
                    great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + grandchild_word.id + "']");
                    for(great_grandchild_word_idx in great_grandchild_words) {
                        great_grandchild_word = great_grandchild_words[great_grandchild_word_idx].$;
                        if (great_grandchild_word.relate === 'ATT' || great_grandchild_word.relate === 'POB' || great_grandchild_word.relate === 'ADV' || great_grandchild_word.relate === 'VOB') {
                            great_great_grandchild_words = xpath.find(json, "//para[@id='" + para_id + "']/sent[@id='" + sent_id + "']/word[@parent='" + great_grandchild_word.id + "']");
                            for(great_great_grandchild_word_idx in great_great_grandchild_words) {
                                great_great_grandchild_word = great_great_grandchild_words[great_great_grandchild_word_idx].$;
                                if (great_great_grandchild_word.relate === 'ATT' || great_great_grandchild_word.relate === 'POB' || great_great_grandchild_word.relate === 'ADV' || great_great_grandchild_word.relate === 'VOB') {
                                    cmps.push(great_great_grandchild_word);
                                }
                            }
                            cmps.push(great_grandchild_word);
                        }
                    }
                    cmps.push(grandchild_word);
                }
            }
            cmps.push(child_word);
        }
    }
    // 去掉标点
    _.remove(advs, function(word) {
        return word.pos === "wp";
    });
    _.remove(cmps, function(word) {
        return word.pos === "wp";
    });
    // 按id去重和排序
    advs = _.sortBy(_.uniqBy(advs, 'id'), function(item) {
        return parseInt(item.id);
    });
    cmps = _.sortBy(_.uniqBy(cmps, 'id'), function(item) {
        return parseInt(item.id);
    });
    // 合并状语
    var adv = "";
    for(i = 0; i < advs.length; i++) {
        if (advs[i].pos === 'nt') {  // 时间
            if (advs[i].cont.indexOf('(') === 0) {
                adv += advs[i].cont;
            } else {
                if (advs[i].cont.indexOf('[') === 0) {
                    adv += "[(" + advs[i].cont.substr(1, advs[i].cont.length - 2) + ")]";
                } else {
                    adv += "(" + advs[i].cont + ")";
                }
            }
        } else if (advs[i].pos === 'nl' || advs[i].pos === 'ns') {  // 地点
            if (advs[i].cont.indexOf('[') === 0) {
                adv += advs[i].cont;
            } else {
                if (advs[i].cont.indexOf('(') === 0) {
                    adv += "([" + advs[i].cont.substr(1, advs[i].cont.length - 2) + "])";
                } else {
                    adv += "[" + advs[i].cont + "]";
                }
            }
        } else if (advs[i].pos === 'nd') {  // 方向
            if (advs[i].cont.indexOf('(') === 0) {
                adv += "(«" + advs[i].cont.substr(1, advs[i].cont.length - 2) + "»)";  // 时间的方向
            } else if (advs[i].cont.indexOf('[') === 0) {
                adv += "[<" + advs[i].cont.substr(1, advs[i].cont.length - 2) + ">]";  // 地点的方向
            } else {
                if (i>0 && (advs[i-1].pos === 'm' || advs[i-1].pos === 'q')) {
                    adv += "«" + advs[i].cont + "»";  // 时间的方向
                } else {
                    adv += "<" + advs[i].cont + ">";  // 地点的方向
                }
            }
        } else if (advs[i].pos === 'm') {  // 数量词
            if (i+1 < advs.length) {
                if (advs[i+1].pos === 'm' || advs[i+1].pos === 'q') {
                    if (advs[i].cont.indexOf('(') === 0 && advs[i+1].cont.indexOf('(') < 0) {
                        adv += "({" + advs[i].cont.substr(1, advs[i].cont.length - 2) + advs[i+1].cont + "})";
                    } else if (advs[i].cont.indexOf('(') < 0 && advs[i+1].cont.indexOf('(') === 0) {
                        adv += "({" + advs[i].cont + advs[i+1].cont.substr(1, advs[i+1].cont.length - 2) + "})";
                    } else if (advs[i].cont.indexOf('(') === 0 && advs[i+1].cont.indexOf('(') === 0) {
                        adv += "({" + advs[i].cont.substr(1, advs[i].cont.length - 2) + advs[i+1].cont.substr(1, advs[i+1].cont.length - 2) + "})";
                    } else if (advs[i].cont.indexOf('[') === 0 && advs[i+1].cont.indexOf('[') < 0) {
                        adv += "[{" + advs[i].cont.substr(1, advs[i].cont.length - 2) + advs[i+1].cont + "}]";
                    } else if (advs[i].cont.indexOf('[') < 0 && advs[i+1].cont.indexOf('[') === 0) {
                        adv += "[{" + advs[i].cont + advs[i+1].cont.substr(1, advs[i+1].cont.length - 2) + "}]";
                    } else if (advs[i].cont.indexOf('[') === 0 && advs[i+1].cont.indexOf('[') === 0) {
                        adv += "[{" + advs[i].cont.substr(1, advs[i].cont.length - 2) + advs[i+1].cont.substr(1, advs[i+1].cont.length - 2) + "}]";
                    } else {
                        adv += "{" + advs[i].cont + advs[i+1].cont + "}";
                    }
                    i++;
                }
            } else {
                var w = words[parseInt(advs[i].id) + 1].$;
                if (w.pos === 'm' || w.pos === 'q') {
                    if (advs[i].cont.indexOf('(') === 0 && w.cont.indexOf('(') < 0) {
                        adv += "({" + advs[i].cont.substr(1, advs[i].cont.length - 2) + w.cont + "})";
                    } else if (advs[i].cont.indexOf('(') < 0 && w.cont.indexOf('(') === 0) {
                        adv += "({" + advs[i].cont + w.cont.substr(1, w.cont.length - 2) + "})";
                    } else if (advs[i].cont.indexOf('(') === 0 && w.cont.indexOf('(') === 0) {
                        adv += "({" + advs[i].cont.substr(1, advs[i].cont.length - 2) + w.cont.substr(1, w.cont.length - 2) + "})";
                    } else if (advs[i].cont.indexOf('[') === 0 && w.cont.indexOf('[') < 0) {
                        adv += "[{" + advs[i].cont.substr(1, advs[i].cont.length - 2) + w.cont + "}]";
                    } else if (advs[i].cont.indexOf('[') < 0 && w.cont.indexOf('[') === 0) {
                        adv += "[{" + advs[i].cont + w.cont.substr(1, w.cont.length - 2) + "}]";
                    } else if (advs[i].cont.indexOf('[') === 0 && w.cont.indexOf('[') === 0) {
                        adv += "[{" + advs[i].cont.substr(1, advs[i].cont.length - 2) + w.cont.substr(1, w.cont.length - 2) + "}]";
                    } else {
                        adv += "{" + advs[i].cont + w.cont + "}";
                    }
                }
            }
        } else {
            if (advs[i].cont.indexOf("(") === 0 || advs[i].cont.indexOf("«") === 0 || advs[i].cont.indexOf("[") === 0 || advs[i].cont.indexOf("<") === 0) {
                adv += advs[i].cont;  // 其他
            } else {
                adv += "~" + advs[i].cont + "~";  // 其他
            }
        }
    }
    adv = adv.replace(/\)\(/g, '').replace(/\]\[/g, '').replace(/~~/g, "").replace(/></g, "").replace(/»«/g, "").replace(/}{/g, '').replace(/\)\(/g, '');
    // 把每个word本身加的()或[]去掉
    for(i = 0; i < advs.length; i++) {
        if (advs[i].cont.indexOf('(') === 0 && advs[i].cont.lastIndexOf(')') === advs[i].cont.length - 1 || advs[i].cont.indexOf('[') === 0 && advs[i].cont.lastIndexOf(']') === advs[i].cont.length - 1) {
            advs[i].cont = advs[i].cont.substr(1, advs[i].cont.length - 2);
        }
    }
    // 合并补语
    var cmp = "";
    for(i = 0; i < cmps.length; i++) {
        if (cmps[i].pos === 'nt') {  // 时间
            if (cmps[i].cont.indexOf('(') === 0) {
                cmp += cmps[i].cont;
            } else {
                if (cmps[i].cont.indexOf('[') === 0) {
                    cmp += "[(" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + ")]";
                } else {
                    cmp += "(" + cmps[i].cont + ")";
                }
            }
        } else if (cmps[i].pos === 'nl' || cmps[i].pos === 'ns') {  // 地点
            if (cmps[i].cont.indexOf('[') === 0) {
                cmp += cmps[i].cont;
            } else {
                if (cmps[i].cont.indexOf('(') === 0) {
                    cmp += "([" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + "])";
                } else {
                    cmp += "[" + cmps[i].cont + "]";
                }
            }
        } else if (cmps[i].pos === 'nd') {  // 方向
            if (cmps[i].cont.indexOf('(') === 0) {
                cmp += "(«" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + "»)";  // 时间的方向
            } else if (cmps[i].cont.indexOf('[') === 0) {
                cmp += "[<" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + ">]";  // 地点的方向
            } else {
                if (i>0 && (cmps[i-1].pos === 'm' || cmps[i-1].pos === 'q')) {
                    cmp += "«" + cmps[i].cont + "»";  // 时间的方向
                } else {
                    cmp += "<" + cmps[i].cont + ">";  // 地点的方向
                }
            }
        } else if (cmps[i].pos === 'm') {  // 数量词
            if (i+1 < cmps.length) {
                if (cmps[i+1].pos === 'm' || cmps[i+1].pos === 'q') {
                    if (cmps[i].cont.indexOf('(') === 0 && cmps[i+1].cont.indexOf('(') < 0) {
                        cmp += "({" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + cmps[i+1].cont + "})";
                    } else if (cmps[i].cont.indexOf('(') < 0 && cmps[i+1].cont.indexOf('(') === 0) {
                        cmp += "({" + cmps[i].cont + cmps[i+1].cont.substr(1, cmps[i+1].cont.length - 2) + "})";
                    } else if (cmps[i].cont.indexOf('(') === 0 && cmps[i+1].cont.indexOf('(') === 0) {
                        cmp += "({" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + cmps[i+1].cont.substr(1, cmps[i+1].cont.length - 2) + "})";
                    } else if (cmps[i].cont.indexOf('[') === 0 && cmps[i+1].cont.indexOf('[') < 0) {
                        cmp += "[{" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + cmps[i+1].cont + "}]";
                    } else if (cmps[i].cont.indexOf('[') < 0 && cmps[i+1].cont.indexOf('[') === 0) {
                        cmp += "[{" + cmps[i].cont + cmps[i+1].cont.substr(1, cmps[i+1].cont.length - 2) + "}]";
                    } else if (cmps[i].cont.indexOf('[') === 0 && cmps[i+1].cont.indexOf('[') === 0) {
                        cmp += "[{" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + cmps[i+1].cont.substr(1, cmps[i+1].cont.length - 2) + "}]";
                    } else {
                        cmp += "{" + cmps[i].cont + cmps[i+1].cont + "}";
                    }
                    i++;
                }
            } else {
                w = words[parseInt(cmps[i].id) + 1].$;
                if (w.pos === 'm' || w.pos === 'q') {
                    if (cmps[i].cont.indexOf('(') === 0 && w.cont.indexOf('(') < 0) {
                        cmp += "({" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + w.cont + "})";
                    } else if (cmps[i].cont.indexOf('(') < 0 && w.cont.indexOf('(') === 0) {
                        cmp += "({" + cmps[i].cont + w.cont.substr(1, w.cont.length - 2) + "})";
                    } else if (cmps[i].cont.indexOf('(') === 0 && w.cont.indexOf('(') === 0) {
                        cmp += "({" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + w.cont.substr(1, w.cont.length - 2) + "})";
                    } else if (cmps[i].cont.indexOf('[') === 0 && w.cont.indexOf('[') < 0) {
                        cmp += "[{" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + w.cont + "}]";
                    } else if (cmps[i].cont.indexOf('[') < 0 && w.cont.indexOf('[') === 0) {
                        cmp += "[{" + cmps[i].cont + w.cont.substr(1, w.cont.length - 2) + "}]";
                    } else if (cmps[i].cont.indexOf('[') === 0 && w.cont.indexOf('[') === 0) {
                        cmp += "[{" + cmps[i].cont.substr(1, cmps[i].cont.length - 2) + w.cont.substr(1, w.cont.length - 2) + "}]";
                    } else {
                        cmp += "{" + cmps[i].cont + w.cont + "}";
                    }
                }
            }
        } else {
            if (cmps[i].cont.indexOf("(") === 0 || cmps[i].cont.indexOf("«") === 0 || cmps[i].cont.indexOf("[") === 0 || cmps[i].cont.indexOf("<") === 0) {
                cmp += cmps[i].cont;  // 其他
            } else {
                cmp += "~" + cmps[i].cont + "~";  // 其他
            }
        }
    }
    cmp = cmp.replace(/\)\(/g, '').replace(/\]\[/g, '').replace(/~~/g, "").replace(/></g, "").replace(/»«/g, "").replace(/}{/g, '').replace(/\)\(/g, '');
    // 把每个word本身加的()或[]去掉
    for(i = 0; i < cmps.length; i++) {
        if (cmps[i].cont.indexOf('(') === 0 && cmps[i].cont.lastIndexOf(')') === cmps[i].cont.length - 1 || cmps[i].cont.indexOf('[') === 0 && cmps[i].cont.lastIndexOf(']') === cmps[i].cont.length - 1) {
            cmps[i].cont = cmps[i].cont.substr(1, cmps[i].cont.length - 2);
        }
    }
    return adv + "【" + word.$.cont + "】" + cmp;
}

app.listen(50000, '0.0.0.0');