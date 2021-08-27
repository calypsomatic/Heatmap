import { GetElementsByAttribute, getElementsValueByXPath } from './xmlfncs.js';
import Voronoi from './assets/rhill-voronoi-core.js';
import StreetPolygon from './StreetPolygon.js';


const debug = true;
var logger = debug ? console.log.bind(console) : function () {};
var group = debug ? console.group.bind(console) : function () {};
var groupEnd = debug ? console.groupEnd.bind(console) : function () {};
const markers = [];
const polygons = [];
const rad = 0.01;

const getAndProcessStreetData = async (currlat, currlon) => {
	group("getAndProcessStreetData");
  const osmapi = "https://www.openstreetmap.org/api/0.6/"
  var osm =	osmapi + "map?bbox="+(currlon-rad)+","+(currlat-rad)+","+(currlon+rad)+","+(currlat+rad)

  //TODO Deal with errors and such
  var resp = await fetch(osm);
  var str = await resp.text();
  var ways_by_refNodeId = {}
	var nodes_by_wayId = {}
	var ways_by_Name = {}
	var wayNames_by_Id = {}
	var intersections_by_wayId = {}
	var allNodesInRelation = {}

  var result = new window.DOMParser().parseFromString(str, "text/xml");
  logger("result: ", result);

  let removeDuplicates = arr => arr.filter((item, index) => arr.indexOf(item) === index);

  let wayids = getElementsValueByXPath('//way/tag[@k="highway" and not(@v="service")]/../tag[@k="name"]/../@id', result);
  logger("wayids: ", wayids);

  var usekey = null;
  //TODO These two different keys are a real mess, deal with them some day
  wayids.forEach((item, i) => {
    var nodegroups = {}
    var maybename = getElementsValueByXPath('//way[@id="'+item+'"]/tag[@k="highway" and not(@v="service")]/../tag[@k="name"]/@v', result);
    var refnodes = getElementsValueByXPath('//way[@id="'+item+'"]/tag[@k="highway" and not(@v="service")]/../tag[@k="name"]/../nd/@ref', result);
    if (maybename.length > 0){
      if (!wayNames_by_Id[item]){
        wayNames_by_Id[item] = maybename[0];
      } else if (wayNames_by_Id[item] != maybename[0]){
         logger("Found two different names: " + wayNames_by_Id[item] + " and " + maybename[0])
      }
      if (!ways_by_Name[maybename[0]]){
        ways_by_Name[maybename[0]] = [item];
      } else if (!ways_by_Name[maybename[0]].includes(item)){
        ways_by_Name[maybename[0]].push(item);
        usekey = ways_by_Name[maybename[0]][0];
      }
    }

    if (allNodesInRelation[usekey]){
      allNodesInRelation[usekey] = merge(allNodesInRelation[usekey],refnodes);
      usekey = null;
    } else {
      allNodesInRelation[item] = refnodes;
    }
  });

    for (const [key, value] of Object.entries(allNodesInRelation)) {
      value.forEach((child, i) => {
          if (!ways_by_refNodeId[child]){
            ways_by_refNodeId[child] = [key];
          } else {
            ways_by_refNodeId[child].push(key);
          }
      });
    }

    logger("wayNames_by_Id: ", wayNames_by_Id);
    logger("ways_by_Name: ", ways_by_Name);
    logger("ways_by_refNodeId: ", ways_by_refNodeId);

    //intersections_by_nodeId's keys are all the nodes that are intersections, and the values are an array of which streets meet it
    var intersections_by_nodeId = Object.fromEntries(Object.entries(ways_by_refNodeId).filter(([k,v]) => v.length>1));

    logger("intersections_by_nodeId: ", intersections_by_nodeId);

  //Dumbest possible way to get rid of those double intersections on mass ave
    let possibledupes = [];
    let intnodes = Object.values(intersections_by_nodeId).map((arr) => {
      let a = arr.slice();
      a.sort();
      return a.toString();
    });
    let count = 0;
    for (const [key, value] of Object.entries(intersections_by_nodeId)) {
      let a = value.slice();
      a.sort();
      // if (intnodes.indexOf(a.toString()) != intnodes.lastIndexOf(a.toString())){
      if (intnodes.indexOf(a.toString()) != count){
        possibledupes.push(key)
      }
      count++;
    }

    intersections_by_nodeId = Object.fromEntries(Object.entries(intersections_by_nodeId).filter(([k,v]) => !possibledupes.includes(k)));

    //We need this to preserve order from nodes_by_wayId
    for (const [key, value] of Object.entries(allNodesInRelation)) {
      var wayixs = value.filter(node => node in intersections_by_nodeId);
  		let coords = wayixs.map( (nodeid) => {
  			let node = GetElementsByAttribute(result, "node", "id", nodeid)[0];
  			return {id: nodeid, coord: {x:parseFloat(node.getAttribute("lat")), y:parseFloat(node.getAttribute("lon"))}};
  		});
  		if (coords.length < 3){
  			intersections_by_wayId[key] = wayixs;
  		}
  		else {
  			let sorted = sortIntoIds(coords);
  	    intersections_by_wayId[key] = sorted;
  		}
    }

    //intersections_by_wayId should be sorted in a line which is not guaranteed to happen
    let intersection_coords = {}

    for (const [key, value] of Object.entries(intersections_by_wayId)) {
      if (value.length < 2){
        var idx = allNodesInRelation[key].indexOf(value[0]);
        if (idx == allNodesInRelation[key].length - 1){
          idx = -1;
        }
        value.push(allNodesInRelation[key][idx+1]);
      }
      let coords = value.map( (nodeid) => {
        let node = GetElementsByAttribute(result, "node", "id", nodeid)[0];
        return {id: nodeid, coord: {x:parseFloat(node.getAttribute("lat")), y:parseFloat(node.getAttribute("lon"))}};
      });
      intersection_coords[key] = coords;
    }

    let testsites = [];
  	let minlon = 1000;
  	let maxlon = -1000;
  	let minlat = 1000;
  	let maxlat = -1000;

    logger("intersections_by_wayId: ", intersections_by_wayId);

    for (const [key, value] of Object.entries(intersections_by_wayId)) {
    		if (value.length == 1){
    			addNodeToTestSites(value[0]);
    		} else {
    			for (let i = 0; i < value.length - 1; i++){
    					let first = getCoordsForNode(value[i]);
    					let second = getCoordsForNode(value[i+1]);
    					let mid = calculateMidpoint(first, second, 0);
    					// logger(mid);
    					if (!isNaN(mid.x) && !isNaN(mid.y)){
    						addCoordsToTestSites(mid);
    					}
    			}
    		}
    	}

    	logger("testing: ", testsites)
    	var bbox = {xl: minlat, xr: maxlat, yt: minlon, yb: maxlon};
    	logger(bbox);
    	var voronoi = new Voronoi();
    	var diagram = voronoi.compute(testsites, bbox);
    	logger(diagram);

    	let polygons = []
    	diagram.cells.forEach((item, i) => {
    		if (i != 0){
    			let corners = item.halfedges.map( (cell) => [[cell.edge.va.x, cell.edge.va.y],[cell.edge.vb.x, cell.edge.vb.y]]);
    			var poly = new StreetPolygon(corners.flat(), i, i);
    			polygons.push(poly);
    		}
    	});

      return { polygons: polygons}
    	groupEnd();

      function getCoordsForNode(nodeid){
        let node = GetElementsByAttribute(result, "node", "id", nodeid)[0];
        let x = parseFloat(node.getAttribute("lat"));
        let y = parseFloat(node.getAttribute("lon"));
        return {x:x, y:y};
      }

      function addCoordsToTestSites(coords){
        testsites.push(coords);
        if (coords.x < minlat){
          minlat = coords.x;
        } else if (coords.x > maxlat){
          maxlat = coords.x;
        }
        if (coords.y < minlon){
          minlon = coords.y;
        } else if (coords.y > maxlon){
          maxlon = coords.y;
        }
      }

      function addNodeToTestSites(nodeid){
        let coords = getCoordsForNode(nodeid);
        addCoordsToTestSites(coords);
      }

      function calculateMidpoint(node1, node2, sign){
           const dist = sign == 0 ? 0.0005 : -0.0005;
           const linevector = [node2.x-node1.x, node2.y-node1.y];
           const lvsize = Math.sqrt(linevector[0]*linevector[0] + linevector[1]*linevector[1]);
           const lvnormal = [linevector[0]/lvsize,linevector[1]/lvsize];
           return {x:node1.x+dist*lvnormal[0],y:node1.y+dist*lvnormal[1]};
        }

      //This is an attempt to keep the correct order of nodes in streets
    	function merge(arr1, arr2){
    		let bigger = arr1.length > arr2.length ? arr1 : arr2;
    		let smaller = arr1.length > arr2.length ? arr2 : arr1;
    		let insertindex = 0;
    		smaller.forEach((item,i) => {
    			if (bigger.includes(item)){
    				insertindex = bigger.indexOf(item)+1;
    			} else {
    				bigger.splice(insertindex,0,item);
    				insertindex++;
    			}
    		});
    		return bigger;
    	}

      function two_farthest(coordlist){
        let farthestdist = 0;
        let farthest1 = null;
        let farthest2 = null;
        for (let i = 0; i < coordlist.length - 1; i++){
          for (let j = i + 1; j < coordlist.length; j++){
              let distance = Math.sqrt(Math.pow(coordlist[i].coord.x-coordlist[j].coord.x,2) + Math.pow(coordlist[i].coord.y-coordlist[j].coord.y,2));
              if (distance > farthestdist){
                farthestdist = distance;
                farthest1 = coordlist[i];
                farthest2 = coordlist[j];
              }
          }
        }

        return [farthest1, farthest2];
      }

      function get_nearest(coord, coordlist){
        let nearestdist = 40042;
        let nearest = null;
        for (let i = 0; i < coordlist.length; i++){
            let distance = Math.sqrt(Math.pow(coordlist[i].coord.x-coord.coord.x,2) + Math.pow(coordlist[i].coord.y-coord.coord.y,2));
            if (distance < nearestdist){
              nearest = coordlist[i];
              nearestdist = distance;
            }
        }

        return nearest;
      }

      function sortIntoIds(coordlist){
        let endpoints = two_farthest(coordlist);
        let sorted = [endpoints[0].id]
        let rest = coordlist.slice();
        rest.splice(rest.indexOf(endpoints[0]),1);
        let curr = endpoints[0];
        while (rest.length > 1){
          let nextpt = get_nearest(curr, rest);
          sorted.push(nextpt.id);
          rest.splice(rest.indexOf(nextpt),1);
          curr = nextpt;
        }
        sorted.push(rest[0].id)
        return sorted;
      }
}

export const createNewIntersections = async (location, existing) => {
  group("createNewIntersections");
  // logger("existing:");
  // logger(existing);

  const currlat = location.lat;
  const currlon = location.lng;

  //Get all the node info and process it first
  let resp = await getAndProcessStreetData(currlat, currlon);
  logger("resp received: ", resp);

//   function addNodesToMarkers(nodes, labelfunc){
//     nodes.forEach((item, i) => {
//       let node = GetElementsByAttribute(result, "node", "id", item)[0]
//       if (node){
//         let ll = new L.LatLng(node.getAttribute("lat"), node.getAttribute("lon"));
//         markers.push({position: ll, label: labelfunc(item, i)});
//       } else {
//         logger("no node ", item);
//       }
//     });
//   }
//
//   for (const [key, value] of Object.entries(intersections_by_wayId)) {
//     // logger(value)
//     addNodesToMarkers(value, labelNode);
// }
return {polygons: resp.polygons, markers: []};
}
