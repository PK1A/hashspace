var parser = require("./parser");
var klass = require("../klass");
var TreeWalker = require("./treeWalker").TreeWalker;
var processors = require("./processors");
var jsv = require("./jsvalidator/validator");

/**
 * Header added to all generated JS file
 */

var HEADER_ARR = [
        '// ################################################################ ',
        '//  This file has been generated by the hashspace compiler          ',
        '//  Direct MODIFICATIONS WILL BE LOST when the file is recompiled!  ',
        '// ################################################################ ',
        '', 'var hsp=require("hsp/rt");', ''];

var HEADER = module.exports.HEADER = HEADER_ARR.join('\r\n');
var HEADER_SZ = HEADER_ARR.length;

/**
 * Compile a template and return a JS compiled string and a list of errors
 * @param template {String} the template file content as a string
 * @param fileName {String} the name of the file being compiled (optional - used for error messages)
 * @param includeSyntaxTree {Boolean} if true, the result object will contain the syntax tree generated by the compiler
 * @param bypassJSvalidation {Boolean} if true, the validation of the generated JS file (including non-template code) is
 * bypassed - default:false
 * @return {JSON} a JSON structure with the following properties:
 *      errors: {Array} the error list - each error having the following structure:
 *          description: {String} - a message describing the error 
 *          line: {Number} - the error line number
 *          column: {Number} - the error column number 
 *          code: {String} - a code extract showing where the error occurs (optional)
 *      code: {String} the generated JavaScript code
 *      syntaxTree: {JSON} the syntax tree generated by the parser (optional - cf. parameters)
 *      lineMap: {Array} array of the new line indexes: lineMap[3] returns the new line index for line 4 in
 *          the orginal file (lineMap[0] is always 0 as all line count starts at 1 for both input and output values)
 */
exports.compile = function (template, path, includeSyntaxTree, bypassJSvalidation) {
    // Parsing might throw an exception
    var res = {};
    var m=path.match(/[^\/]+$/), fileName=m? m[0] : 'unknown', dirPath='';
    if (fileName.length<path.length) {
        dirPath=path.slice(0,-fileName.length);
    }


    if (!template) {
        res.errors = [{
            description : "[Hashspace compiler] template argument is undefined"
        }];
    } else {
        res = parser.parse(template);
    }

    res.code = '';

    if (!res.errors || !res.errors.length) {
        // I'm sure res is an array otherwise the parser would have thrown an exception
        var w = new TemplateWalker(fileName,dirPath);
        var out = w.walk(res.syntaxTree, processors);

        if (includeSyntaxTree === true) {
            res.codeFragments = w.templates;
        }

        res.code = HEADER + out.join('\r\n');
        res.errors = w.errors;

        generateLineMap(res, template);
    } else {
        // Generate a JS script to show the errors when the generated file is loaded
        res.code = HEADER;
    }

    if (!res.errors) {
        res.errors = [];
    } else if (res.errors.length > 0) {
        // remove all code so that script can still be loaded
        res.code = HEADER;
    }

    if (res.errors.length === 0 && bypassJSvalidation !== true) {
        // call the JS validator
        // we don't checke for JS errors when there are template errors as the code generated by the template may be
        // wrong
        var r = jsv.validate(res.code);
        if (!r.isValid) {
            // remove all code so that script can still be loaded
            res.code = HEADER;

            // translate error line numbers
            var err, ln, lm = res.lineMap;
            for (var i = 0, sz = r.errors.length; sz > i; i++) {
                err = r.errors[i];
                ln = err.line;

                err.line = -1; // to avoid sending a wrong line in case of pb
                for (var j = 0, sz2 = lm.length; sz2 > j; j++) {
                    if (lm[j] === ln) {
                        err.line = j; // original line nbr
                        break;
                    }
                }
            }

            Array.prototype.push.apply(res.errors, r.errors);
        }
    }

    res.code += getErrorScript(res.errors, fileName);

    if (includeSyntaxTree !== true) {
        res.syntaxTree = null;
    }

    return res;
};

/**
 * Generate an error script to include in the template compiled script in order to show errors in the browser when the
 * script is loaded
 */
function getErrorScript (errors, fileName) {
    var r = '';
    if (errors && errors.length) {
        r = ['\r\nrequire("hsp/rt").logErrors("', fileName, '",', JSON.stringify(errors, null), ');\r\n'].join("");
    }
    return r;
}

/**
 * Generate the line map of a compilatin result
 * @param {JSON} res the result object of a compilation - cf. compile function
 * @param {String} file the template file (before compilation)
 */
function generateLineMap (res, file) {
    if (res.errors && res.errors.length) {
        return;
    }
    var st = res.syntaxTree, templates = [];
    // identify the templates in the syntax tree
    for (var i = 0; st.length > i; i++) {
        if (st[i].type === 'template') {
            templates.push(st[i]);
        }
    }

    var nbrOfLinesInCompiledTemplate = 5;
    var lm = [], sz = file.split(/\n/g).length + 1, pos = HEADER_SZ, tpl;
    var pos1 = -1; // position of the next template start
    var pos2 = -1; // position of the next template end
    var tplIdx = -1; // position of the current template

    for (var i = 0; sz > i; i++) {
        if (i === 0 || i === pos2) {
            // end of current template: let's determine next pos1 and pos2
            tplIdx = (i === 0) ? 0 : tplIdx + 1;
            if (tplIdx < templates.length) {
                // there is another template
                tpl = templates[tplIdx];
                pos1 = tpl.startLine;
                pos2 = tpl.endLine;
                if (pos2 < pos1) {
                    // this case should never arrive..
                    pos2 = pos1;
                }
            } else {
                // last template has been found
                tplIdx = pos1 = pos2 = -1;
            }
            if (i === 0) {
                lm[0] = 0;
            }
            i++;
        }
        if (i === pos1) {
            for (var j = pos1, max = pos2 + 1; max > j; j++) {
                // all lines are set to the template start
                lm[i] = pos;
                i++;
            }
            pos += nbrOfLinesInCompiledTemplate;
            i -= 2; // to enter the i===pos2 clause at next step
        } else {
            lm[i] = pos;
            pos++;
        }
    }

    res.lineMap = lm;
}

/**
 * Walker object used to generate the template script and store some contextual information such as errors or scope..
 */
var TemplateWalker = klass({
    $extends : TreeWalker,
    $constructor : function (fileName,dirPath) {
        this.fileName=fileName;
        this.dirPath=dirPath;
        this.templates = {}; // used by processors to store intermediate values in order to ease testing
        this.globals={};     // global validation code for each template - used for unit testing
        this.errors = [];
        this.resetGlobalRefs();
        this.resetScope();
    },

    logError : function (description, errdesc) {
        var desc = {
            description : description
        };
        if (errdesc) {
            if (errdesc.line) {
                desc.line = errdesc.line;
                desc.column = errdesc.column;
            }
            if (errdesc.code) {
                desc.code = errdesc.code;
            }
        }
        this.errors.push(desc);
    },

    // reset the list of global variables that have been found since the last reset
    resetGlobalRefs : function () {
        this._globals=[];
        this._globalKeys={};
    },

    // add a global reference (e.g. "foo") to the current _globals list
    addGlobalRef : function (ref) {
        if (!this._globalKeys[ref]) {
            this._globals.push(ref);
            this._globalKeys[ref]=true;
        }
    },

    // reset the scope variables that are used to determine if a variable name is in the current scope
    resetScope : function () {
        this._scopes = [{}];
        this._scope = this._scopes[0];
    },

    addScopeVariable : function (varname) {
        this._scope[varname] = true;
    },

    rmScopeVariable : function (varname) {
        this._scope[varname] = null;
    },

    isInScope : function (varname) {
        if (varname === "scope") {
            return true; // scope is a reserved key word and is automatically created on the scope object
        }
        return this._scope[varname] ? true : false;
    },

    pushSubScope : function (vararray) {
        var newScope = Object.create(this._scope);
        for (var i = 0, sz = vararray.length; sz > i; i++) {
            newScope[vararray[i]] = true;
        }
        this._scopes.push(newScope);
        this._scope = this._scopes[this._scopes.length - 1];
    },

    popSubScope : function (varnames) {
        this._scopes.pop();
        this._scope = this._scopes[this._scopes.length - 1];
    }
});
